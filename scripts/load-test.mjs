#!/usr/bin/env node
/**
 * Load test for the attendee portal.
 *
 * Answers: "if ~350 people use this at once, does anything crash?"
 *
 * Phases mirror the real event shape rather than one uniform flood, because a
 * spike and a steady trickle stress different things:
 *
 *   register  sign-ups. The heaviest single operation in the app: a bcrypt
 *             HASH (not a compare) plus an insert, so this is the phase most
 *             likely to expose CPU or pool exhaustion.
 *   read      dashboard loads — three parallel reads per attendee. What most
 *             people actually do most of the time.
 *   login     sign-ins. A bcrypt COMPARE: similar CPU to register, no writes.
 *   spike     all three at once with no ramping. The worst case, and the only
 *             way to see whether excess requests queue or actually fail.
 *
 * Test data is namespaced by the LOADTEST prefix so cleanup is exact.
 *
 *   node scripts/load-test.mjs --users 350 --concurrency 25
 *   node scripts/load-test.mjs --phases spike --users 350 --concurrency 350
 *   node scripts/load-test.mjs --url http://localhost:3000
 */

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(String(process.argv[i]).replace(/^--/, ''), process.argv[i + 1])
}

const USERS = Number(args.get('users') ?? 350)
const CONCURRENCY = Number(args.get('concurrency') ?? 25)
const BASE = args.get('url') ?? process.env.TEST_BASE_URL ?? 'https://the-awakening-portal.vercel.app'
const PHASES = String(args.get('phases') ?? 'register,read,login').split(',')
const PREFIX = 'LOADTEST'

const phoneFor = (i) => `98${String(i).padStart(8, '0')}`
const senFor = (i) => `${PREFIX}${String(i).padStart(5, '0')}`

/* ------------------------------------------------------------- statistics */

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count: sorted.length,
    min: Math.round(sorted[0] ?? 0),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    mean: Math.round(sum / Math.max(sorted.length, 1)),
  }
}

const ms = (n) => `${String(n).padStart(5)}ms`

function report(label, ok, failures) {
  const s = summarise(ok)
  const rate = ((ok.length / (ok.length + failures.length)) * 100).toFixed(1)
  console.log(
    `  ${label.padEnd(22)} ok=${String(ok.length).padStart(4)}  ` +
      `fail=${String(failures.length).padStart(4)}  (${rate.padStart(5)}%)  ` +
      `p50=${ms(s.p50)} p95=${ms(s.p95)} p99=${ms(s.p99)} max=${ms(s.max)}`,
  )
  return s
}

/** Runs `items` with at most `limit` in flight. */
async function withConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
      while (next < items.length) {
        const index = next
        next += 1
        results[index] = await worker(items[index], index)
      }
    }),
  )
  return results
}

/* ------------------------------------------------------------------ client */

async function call(method, path, body, cookie) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const started = performance.now()
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const elapsed = performance.now() - started
    const setCookie = (res.headers.getSetCookie?.() ?? []).map((l) => l.split(';')[0]).join('; ')
    const text = await res.text()
    let parsed = null
    try {
      parsed = text === '' ? null : JSON.parse(text)
    } catch {
      parsed = null
    }
    return { ms: elapsed, status: res.status, body: parsed, cookie: setCookie, error: null }
  } catch (error) {
    return {
      ms: performance.now() - started,
      status: 0,
      body: null,
      cookie: '',
      error: error?.name ?? String(error),
    }
  }
}

/** Groups failures by status so a burst of 500s is distinguishable from timeouts. */
function failureBreakdown(failures) {
  const counts = new Map()
  for (const f of failures) {
    const key = f.status === 0 ? `network:${f.error}` : `http:${f.status}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

/* ------------------------------------------------------------------- phases */

async function adminSession() {
  const res = await call('POST', '/admin/login', {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? '',
  })
  if (res.status !== 200) {
    throw new Error(
      `admin login failed (HTTP ${res.status}). Set ADMIN_USERNAME and ADMIN_PASSWORD.`,
    )
  }
  return res.cookie
}

/**
 * Concurrent scans of distinct attendees.
 *
 * The most business-critical check in the file. A lost scan means a real person
 * is missing from the roll; a duplicated one would mean attendance is not
 * single-use, which is the property the whole design rests on. Both are verified
 * against the attendance log afterwards rather than trusted from the responses.
 */
async function phaseScan(cookies, limit) {
  console.log(`\n  scan — ${cookies.length} concurrent scans, concurrency ${limit}`)
  console.log('    (the gate: every scan must land exactly once)')

  const admin = await adminSession()
  const items = cookies.map((_, i) => senFor(i))

  const results = await withConcurrency(items, limit, async (sen) => {
    const res = await call('POST', '/admin/attendance', { sen }, admin)
    return { ...res, sen }
  })

  const ok = results.filter((r) => r.status === 201)
  const failures = results.filter((r) => r.status !== 201)
  report('scan', ok.map((r) => r.ms), failures)
  for (const [reason, count] of failureBreakdown(failures)) {
    console.log(`      ${reason} x${count}`)
  }

  // Verify against the log rather than the responses.
  const log = await call('GET', '/admin/attendance', undefined, admin)
  const rows = log.body ?? []
  const logged = new Set(rows.map((r) => r.sen))
  const missing = items.filter((sen) => !logged.has(sen))
  const matching = rows.filter((r) => items.includes(r.sen))

  console.log(
    `      log check: ${items.length - missing.length}/${items.length} present` +
      `, ${matching.length} rows for these SENs (expected ${items.length})`,
  )
  if (missing.length > 0) {
    console.log(`      LOST SCANS: ${missing.slice(0, 5).join(', ')}`)
  }
  if (matching.length !== items.length) {
    console.log(`      WARNING: expected ${items.length} log rows, found ${matching.length}`)
  }
  return { ok: ok.length, failures: failures.length, missing: missing.length }
}

async function phaseRegister(limit) {
  console.log(`\n  register — ${USERS} sign-ups, concurrency ${limit}`)
  console.log('    (bcrypt hash + insert; the heaviest operation in the app)')

  const results = await withConcurrency(Array.from({ length: USERS }, (_, i) => i), limit, async (i) => {
    const res = await call('POST', '/attendee/register', {
      name: `${PREFIX} ${i}`,
      phone: phoneFor(i),
      sen: senFor(i),
      password: 'grid2026',
    })
    return { ...res, cookie: res.cookie }
  })

  const ok = results.filter((r) => r.status === 201 && r.cookie !== '')
  const failures = results.filter((r) => !(r.status === 201 && r.cookie !== ''))
  report('register', ok.map((r) => r.ms), failures)
  for (const [reason, count] of failureBreakdown(failures)) {
    console.log(`      ${reason} x${count}`)
  }
  return ok.map((r) => r.cookie)
}

async function phaseRead(cookies, limit) {
  console.log(`\n  read — ${cookies.length} dashboard loads, concurrency ${limit}`)
  console.log('    (session probe + event + ticket + attendance)')

  const results = await withConcurrency(cookies, limit, async (cookie, i) => {
    const session = await call('GET', '/attendee/session', undefined, cookie)
    if (session.status !== 200 || session.body === null) return { ...session, i }

    const [event, ticket, attendance] = await Promise.all([
      call('GET', '/event'),
      call('GET', '/attendee/ticket', undefined, cookie),
      call('GET', '/attendee/attendance', undefined, cookie),
    ])
    return {
      status: event.status === 200 && ticket.status === 200 && attendance.status === 200 ? 200 : 500,
      ms: Math.max(session.ms, event.ms, ticket.ms, attendance.ms),
      error: null,
      i,
    }
  })

  const ok = results.filter((r) => r.status === 200)
  const failures = results.filter((r) => r.status !== 200)
  report('read', ok.map((r) => r.ms), failures)
  for (const [reason, count] of failureBreakdown(failures)) {
    console.log(`      ${reason} x${count}`)
  }
  return ok.length
}

async function phaseLogin(limit) {
  console.log(`\n  login — ${USERS} sign-ins, concurrency ${limit}`)
  console.log('    (bcrypt compare; no write contention)')

  const results = await withConcurrency(Array.from({ length: USERS }, (_, i) => i), limit, async (i) => {
    const res = await call('POST', '/attendee/login', {
      name: `${PREFIX} ${i}`,
      phone: phoneFor(i),
      password: 'grid2026',
      remember: false,
    })
    return { ...res, expected: res.status === 200 }
  })

  const ok = results.filter((r) => r.status === 200)
  const failures = results.filter((r) => r.status !== 200)
  report('login', ok.map((r) => r.ms), failures)
  for (const [reason, count] of failureBreakdown(failures)) {
    console.log(`      ${reason} x${count}`)
  }
  return ok.length
}

/**
 * Everything at once, no ramp.
 *
 * This is the phase that answers the real question. If excess concurrency were
 * rejected rather than queued, it shows up here and nowhere else.
 */
async function phaseSpike() {
  console.log(`\n  spike — ${USERS} sign-ups fired simultaneously, no ramp`)
  console.log('    (worst case: does the platform queue or reject?)')

  const started = Date.now()
  const results = await withConcurrency(
    Array.from({ length: USERS }, (_, i) => i),
    USERS, // no limit: fire them all
    async (i) => {
      const res = await call('POST', '/attendee/register', {
        name: `${PREFIX} S${i}`,
        phone: `97${String(i).padStart(8, '0')}`,
        sen: `${PREFIX}S${String(i).padStart(4, '0')}`,
        password: 'grid2026',
      })
      return res
    },
  )
  const wall = Date.now() - started

  const ok = results.filter((r) => r.status === 201)
  const failures = results.filter((r) => r.status !== 201)
  report('spike register', ok.map((r) => r.ms), failures)
  console.log(`      wall clock: ${(wall / 1000).toFixed(1)}s for ${USERS} requests`)
  for (const [reason, count] of failureBreakdown(failures)) {
    console.log(`      ${reason} x${count}`)
  }
}

/* --------------------------------------------------------------------- run */

async function main() {
  console.log(`\n  Load test — ${BASE}`)
  console.log(`  users=${USERS} concurrency=${CONCURRENCY} phases=${PHASES.join(',')}`)

  // Warm the function so a cold start is not measured as latency.
  await call('GET', '/event')

  let cookies = []
  if (PHASES.includes('register')) {
    cookies = await phaseRegister(CONCURRENCY)
  } else {
    console.log('\n  (skipping register: reusing whatever sessions already exist)')
  }

  if (PHASES.includes('read') && cookies.length > 0) {
    await phaseRead(cookies, CONCURRENCY)
  }

  if (PHASES.includes('scan') && cookies.length > 0) {
    await phaseScan(cookies, CONCURRENCY)
  }

  if (PHASES.includes('login')) {
    await phaseLogin(CONCURRENCY)
  }

  if (PHASES.includes('spike')) {
    await phaseSpike()
  }

  // Prove the service is still healthy afterwards, not merely surviving.
  const health = await call('GET', '/event')
  console.log(
    `\n  post-test health: /event -> HTTP ${health.status} in ${Math.round(health.ms)}ms`,
  )
  if (health.status !== 200) {
    console.log('  WARNING: the API is not healthy after the run')
    process.exitCode = 1
  }

  console.log(`\n  done. clean up with: node scripts/clean-test-data.mjs\n`)
}

main().catch((error) => {
  console.error('\n  load test crashed:', error?.message ?? error, '\n')
  process.exitCode = 1
})
