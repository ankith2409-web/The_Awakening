#!/usr/bin/env node
/**
 * Register N attendees and watch what breaks.
 *
 * Written because "does it survive a queue" deserves an answer that is measured
 * rather than assumed, and because the interesting failures here are not the obvious
 * ones. A 500 is loud and easy to spot. The things worth hunting are the quiet ones:
 * a request that takes four minutes and still returns 201, a rate the database
 * absorbs until it does not, the site answering fine while registration is quietly
 * degraded.
 *
 * WHAT THIS MEASURES, AND WHAT IT CANNOT
 *
 * Registration is four queries and one bcrypt hash, and the hash is the whole cost:
 * 90ms of pure CPU, in a pure-JS implementation, on a single-threaded runtime.
 * Concurrency therefore does not make it faster -- it queues the CPU work. This is
 * the single most important thing the numbers will show, and it is invisible in a
 * request-level test because every individual request is perfectly healthy.
 *
 * Against production, the number that decides whether this survives is the function's
 * CPU budget, not the database's. 350 at once is 31.5 seconds of CPU. Nobody queues
 * 350 people at a desk, but a shared link on college wifi, or a deploy that recompiles
 * cold while the first cohort arrives, is the realistic version of the same problem.
 *
 *   --count N          how many to register          (default 350)
 *   --concurrency N    in flight at once             (default 8)
 *   --base URL         target                        (default localhost:3000)
 *   --keep             skip cleanup, for inspecting afterwards
 *
 * CLEANUP IS SCOPED TO THIS RUN'S OWN IDs, ALWAYS, AND IS VERIFIED.
 *
 * That is not a style preference. An earlier version of a test in this repository
 * deleted a real attendee's attendance record by picking the first row in the table,
 * and a throwaway script emptied the whole attendance log. Both were mine. A load
 * test is the worst possible place for an unscoped DELETE, because it is deliberately
 * large, and the cleanup runs whether the load passed or failed.
 */

import { Client } from 'pg'
import { loadEnv } from './_env.mjs'

loadEnv()

/* --------------------------------------------------------------------- args */

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const COUNT = Number(arg('count', '350'))
const CONCURRENCY = Number(arg('concurrency', '8'))
const BASE = arg('base', 'http://localhost:3000')
const KEEP = args.includes('--keep')

/*
  A per-run marker, so every row this script creates is identifiable afterwards and
  the cleanup can be proved narrow.

  Four digits, taken from the clock, forming the first four digits of both the SEN and
  the phone. The phone has to be ten digits starting with 9, so `9` + marker(4) +
  index(5); the SEN is a letter plus twelve digits, so `Z` + marker(4) + index(8).
  Different digit counts on purpose: the index is wider in the SEN so that a run of
  350 cannot collide with a neighbouring run's.
*/
const MARKER = String(Date.now() % 10000).padStart(4, '0')

function senFor(i) {
  return `Z${MARKER}${String(i).padStart(8, '0')}`
}
function phoneFor(i) {
  return `9${MARKER}${String(i).padStart(5, '0')}`
}

/*
  Names must satisfy the registration name rule: letters, marks, period, apostrophe,
  space and hyphen -- and NO DIGITS. A realistic mix of scripts, because the rule is
  the thing most likely to reject a real student and the thing a load test full of
  "Load Test 1" would fail for the wrong reason.
*/
const NAMES = [
  'Ananya Krishnan',
  'Rohit Sharma',
  'Meera Nair',
  'Arjun Reddy',
  'Divya Menon',
  'Karthik Iyer',
  'Sneha Pillai',
  'Vikram Desai',
  'Anjali Rao',
  'Rahul Verma',
  'Fatima Sheikh',
  'Zoya Khan',
  'Jean-Luc Picard',
  'Mary Ann Cooper',
  'Grace Hopper',
  'Ada Lovelace',
  'Katherine Johnson',
  'José Álvarez',
  'François Dubois',
  'Nguyễn Văn An',
  '山田 太郎',
  'अनुष शर्मा',
  'അനുഷ കൃഷ്ണൻ',
]

/* ---------------------------------------------------------------- reporting */

const results = []
let created = 0
let aborted = false

function pct(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function summarise() {
  const byStatus = new Map()
  for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)

  const latencies = results.map((r) => r.ms).sort((a, b) => a - b)
  const succeeded = results.filter((r) => r.status === 201)

  console.log('\n  --- outcome ---')
  for (const [status, n] of [...byStatus].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${String(status).padEnd(5)} ${String(n).padStart(4)}`)
  }

  console.log('\n  --- latency (ms) ---')
  console.log(`  min      ${latencies[0] ?? 0}`)
  console.log(`  p50      ${pct(latencies, 0.5)}`)
  console.log(`  p90      ${pct(latencies, 0.9)}`)
  console.log(`  p99      ${pct(latencies, 0.99)}`)
  console.log(`  max      ${latencies[latencies.length - 1] ?? 0}`)

  /*
    The trend that matters more than any single number. If the tail grows while the
    median holds, the system is degrading under its own load rather than being slow
    from the start -- which is the difference between "needs a bigger box" and "about
    to fall over".
  */
  const firstHalf = latencies.slice(0, Math.floor(latencies.length / 2))
  const secondHalf = latencies.slice(Math.floor(latencies.length / 2))
  const median = (a) => pct(a.sort((x, y) => x - y), 0.5)
  const drift = median(secondHalf) - median(firstHalf)
  console.log(
    `  drift    ${drift >= 0 ? '+' : ''}${drift}ms (second half vs first half median)`,
  )

  console.log(`\n  registered ${succeeded.length} of ${results.length}`)
  if (aborted) console.log('  ABORTED early — see the first error above')
}

/* -------------------------------------------------------------------- main */

async function healthProbe() {
  const started = Date.now()
  try {
    const res = await fetch(`${BASE}/api/event`, {
      signal: AbortSignal.timeout(8000),
    })
    return { ok: res.ok, ms: Date.now() - started, status: res.status }
  } catch (cause) {
    return { ok: false, ms: Date.now() - started, status: 0, error: String(cause) }
  }
}

let db

async function main() {
  console.log(`\n  load test against ${BASE}`)
  console.log(`  ${COUNT} registrations, ${CONCURRENCY} in flight, marker ${MARKER}`)

  if (COUNT > 0) {
    const before = await healthProbe()
    console.log(`  health before: ${before.ok ? `ok (${before.ms}ms)` : `DOWN (${before.status})`}`)
    if (!before.ok) {
      console.log('  refusing to start against an unhealthy target')
      process.exitCode = 1
      return
    }
  }

  /*
    A probe running alongside the load, on its own schedule.

    The question is not only "did the registrations succeed" but "was the rest of the
    site still answering while they did". A system that serves 350 registrations and
    refuses the event feed at the same time is not working, however green the
    registration column looks.
  */
  let probing = true
  const probes = []
  const prober = (async () => {
    while (probing) {
      probes.push(await healthProbe())
      await new Promise((r) => setTimeout(r, 2000))
    }
  })()

  const started = Date.now()
  let issued = 0
  let index = 0

  async function worker() {
    for (;;) {
      const i = index
      index += 1
      if (i >= COUNT || aborted) return
      issued += 1

      const body = {
        name: NAMES[i % NAMES.length],
        phone: phoneFor(i),
        sen: senFor(i),
      }

      const at = Date.now()
      try {
        const res = await fetch(`${BASE}/api/attendee/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        })
        const text = await res.text()
        results.push({ status: res.status, ms: Date.now() - at, text: text.slice(0, 120) })

        if (res.status === 201) created += 1

        /*
          A 5xx is the one result worth stopping for.

          Not because the test is precious — because a 500 under load usually means an
          exhausted resource, and continuing turns one bad signal into three hundred
          and hides which request caused it. Anything 4xx is a legitimate refusal and
          is recorded, not acted on.
        */
        if (res.status >= 500) {
          aborted = true
          console.log(`\n  ABORTING on ${res.status}: ${text.slice(0, 160)}`)
          return
        }
      } catch (cause) {
        results.push({
          status: 0,
          ms: Date.now() - at,
          text: `threw: ${String(cause).slice(0, 120)}`,
        })
        console.log(`\n  ABORTING after a thrown request: ${String(cause).slice(0, 160)}`)
        aborted = true
        return
      }

      if (issued % 50 === 0) {
        const good = results.filter((r) => r.status === 201).length
        console.log(`  ${issued}/${COUNT} issued, ${good} created`)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  probing = false
  await prober

  const wall = Date.now() - started
  console.log(`\n  wall clock: ${(wall / 1000).toFixed(1)}s for ${issued} registrations`)
  console.log(`  throughput: ${(issued / (wall / 1000)).toFixed(1)}/s`)

  const during = probes.slice(1, -1)
  const unhealthy = during.filter((p) => !p.ok)
  console.log(
    `\n  event feed during the load: ${during.length} probes, ${unhealthy.length} unhealthy`,
  )
  if (unhealthy.length > 0) {
    console.log(
      `    worst: ${Math.max(...during.map((p) => p.ms))}ms; statuses ${[
        ...new Set(unhealthy.map((p) => p.status || p.error)),
      ].join(', ')}`,
    )
    console.log('    the site was NOT fully healthy while registrations were running')
  }

  summarise()

  /* -------------------------------------------------------- what landed in the db */

  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await db.connect()

  const { rows: landed } = await db.query(
    'select count(*)::int as n from attendees where sen like $1',
    [`Z${MARKER}%`],
  )
  const { rows: sessions } = await db.query(
    `select count(*)::int as n from sessions
      where subject_id in (select id from attendees where sen like $1)`,
    [`Z${MARKER}%`],
  )

  console.log('\n  --- in the database ---')
  console.log(`  attendees created  ${landed[0].n} (API reported ${created})`)
  console.log(`  sessions created   ${sessions[0].n}`)

  if (landed[0].n !== created) {
    console.log(
      `  MISMATCH: the API reported ${created} successes and the database holds ${landed[0].n}`,
    )
  }

  /* --------------------------------------------------------------- cleanup */

  if (KEEP) {
    console.log(`\n  --keep given. Rows left behind carry SEN prefix Z${MARKER}`)
    console.log(`  to remove: delete from attendees where sen like 'Z${MARKER}%'`)
    return
  }

  console.log('\n  --- cleanup ---')
  const removed = await db.query(
    `delete from attendees where sen like $1 returning id`,
    [`Z${MARKER}%`],
  )
  const ids = removed.rows.map((r) => r.id)
  if (ids.length > 0) {
    await db.query('delete from attendance where attendee_id = any($1::uuid[])', [ids])
    await db.query('delete from sessions where subject_id = any($1::uuid[])', [ids])
  }

  const { rows: leftAttendees } = await db.query(
    'select count(*)::int as n from attendees where sen like $1',
    [`Z${MARKER}%`],
  )
  /*
    Sessions have no foreign key to attendees.

    `sessions.subject_id` is a bare uuid with no ON DELETE CASCADE, so deleting an
    attendee does NOT delete their sessions -- they simply stop resolving to anybody.
    A load test that registers hundreds of people and then removes them therefore
    leaves hundreds of unreachable session rows behind, and the first run of this
    script in this repository left 70 of them.

    They are not a security problem: `currentSession` matches on the token alone, so an
    orphan resolves only to its own deleted account and can see nothing anybody else
    owns. But they are garbage, they accumulate, and a suite that leaves garbage behind
    is a suite nobody can trust. Purged here, scoped to attendees that no longer exist.
  */
  const orphaned = await db.query(
    `delete from sessions s
       where s.kind = 'attendee'
         and not exists (select 1 from attendees a where a.id = s.subject_id)
       returning 1`,
  )
  if (orphaned.rowCount > 0) {
    console.log(`  also removed ${orphaned.rowCount} orphaned attendee sessions (no FK to cascade)`)
  }

  const { rows: leftSessions } = await db.query(
    `select count(*)::int as n from sessions
      where subject_id in (select id from attendees where sen like $1)`,
    [`Z${MARKER}%`],
  )

  console.log(`  removed ${ids.length} attendees and their sessions`)
  console.log(
    `  verified: ${leftAttendees[0].n} attendees, ${leftSessions[0].n} sessions remain`,
  )

  if (leftAttendees[0].n !== 0) {
    console.log('  CLEANUP INCOMPLETE — run the delete printed above before relying on the count')
    process.exitCode = 1
  }

  const { rows: realTotal } = await db.query('select count(*)::int as n from attendees')
  console.log(`  real attendees in the database: ${realTotal[0].n}`)
}

main()
  .catch((error) => {
    console.error('\n  crashed:', error.stack ?? error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    if (db) await db.end().catch(() => {})
  })