#!/usr/bin/env node
/**
 * Focused checks for the two features added most recently.
 *
 * Run against a live API:  node scripts/test-gate-and-reset.mjs
 */

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'

let passed = 0
let failed = 0
let skipped = 0

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function skip(label, why) {
  skipped += 1
  console.log(`  skip  ${label}\n          ${why}`)
}

/**
 * Reset calls must pass the run's IP as the FIFTH argument.
 *
 * Getting this wrong fails silently and expensively: the value lands in the
 * `cookie` slot, no x-forwarded-for header is sent, every run then shares a
 * single `unknown` bucket in the limiter, and the suite passes once and fails
 * on every run after — which reads like a flaky test rather than a wrong call.
 */
async function call(method, path, body, cookie, ip) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  // The rate limiter budgets per caller IP as well as per number. Sending a
  // unique IP per run keeps repeated runs from sharing — and exhausting — one
  // budget, so the suite is repeatable.
  if (ip) headers['x-forwarded-for'] = ip

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const setCookie = (res.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(';')[0])
    .join('; ')

  const text = await res.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return {
    status: res.status,
    body: parsed,
    cookie: setCookie,
    headers: res.headers,
  }
}

async function main() {
  console.log(`\n  Testing ${BASE}\n`)
  const runId = Date.now().toString().slice(-5)
  /*
    A fresh caller identity per run, so the per-IP budget starts empty and
    back-to-back runs cannot exhaust each other's.

    Drawn from 198.18.0.0/15 (RFC 2544 benchmarking space) rather than
    something timestamp-shaped: an earlier version used
    `203.0.113.${Date.now() % 250}`, which gave only 250 distinct values and
    collided between consecutive runs. 65k values plus randomness makes a
    collision between back-to-back runs negligible.
  */
  const octets = Math.floor(Math.random() * 65_000)
  const ip = `198.18.${Math.floor(octets / 256)}.${octets % 256}`
  const senQr = `SEN${runId}Q`
  const senBare = `SEN${runId}B`
  const phoneQr = `9${runId}11111`.slice(0, 10)
  const phoneBare = `8${runId}22222`.slice(0, 10)

  /* -- setup: two attendees, one ticket we can sign ------------------------ */
  const a = await call('POST', '/attendee/register', {
    name: 'Qr Tester', phone: phoneQr, sen: senQr, password: 'grid2026',
  })
  check('registered the QR-path attendee', a.status === 201, `got ${a.status}`)

  const b = await call('POST', '/attendee/register', {
    name: 'Bare Tester', phone: phoneBare, sen: senBare, password: 'grid2026',
  })
  check('registered the bare-SEN attendee', b.status === 201, `got ${b.status}`)

  const ticket = await call('GET', '/attendee/ticket', undefined, a.cookie)
  const signed = ticket.body?.encoded ?? ''
  check('ticket is signed', signed.startsWith(senQr + '.'), signed.slice(0, 40))

  const admin = await call('POST', '/admin/login', {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? '',
  })
  check('admin signed in', admin.status === 200, `got ${admin.status}`)

  /* -- gate: signature verification ---------------------------------------- */
  const scanned = await call('POST', '/admin/attendance', { sen: signed }, admin.cookie)
  check('genuine signed QR is admitted as "qr"', scanned.body?.method === 'qr',
    `method=${scanned.body?.method} status=${scanned.status}`)

  // Signature swapped for garbage: must NOT be treated as a verified pass.
  const forged = `${senBare}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
  const forgedScan = await call('POST', '/admin/attendance', { sen: forged }, admin.cookie)
  check('forged signature is downgraded to "printed"', forgedScan.body?.method === 'printed',
    `method=${forgedScan.body?.method} status=${forgedScan.status}`)
  check('forged signature still admits the attendee (staff fallback)', forgedScan.status === 201,
    `got ${forgedScan.status}`)

  // A well-formed payload with the signature stripped entirely.
  const bareScan = await call('POST', '/admin/attendance', { sen: senBare }, admin.cookie)
  check('bare re-scan is rejected as already checked in', bareScan.status === 409,
    `got ${bareScan.status}`)

  const log = await call('GET', '/admin/attendance', undefined, admin.cookie)
  const qrRow = log.body?.find((r) => r.sen === senQr)
  const bareRow = log.body?.find((r) => r.sen === senBare)
  check('QR row persisted method=qr', qrRow?.method === 'qr', `got ${qrRow?.method}`)
  check('forged row persisted method=printed', bareRow?.method === 'printed', `got ${bareRow?.method}`)

  /* -- password reset ------------------------------------------------------ */
  /*
    Stop if the shared per-IP budget is already spent.

    Vercel overwrites `x-forwarded-for` with the real client IP, so on a hosted
    deployment every caller — this suite included, plus anyone probing the
    endpoint — shares one bucket. Twenty resets an hour is the ceiling and this
    suite spends a dozen per run, so after a few runs the budget is gone and
    every assertion below fails with 429, reading like the reset endpoint is
    broken when it is the limiter doing exactly its job.

    Checked on the first real call rather than on a separate probe: a probe
    spends budget too, so it could take the last slot and leave the section to
    fail on the very next request. Run against the local harness to exercise
    this for real.
  */
  const reset = await call('POST', '/attendee/password/reset', {
    phone: phoneQr, password: 'newpass2026',
  }, undefined, ip)

  if (reset.status === 429) {
    skip(
      'the password-reset section',
      `the shared per-IP budget for this caller is already exhausted (HTTP 429, ` +
        `Retry-After ${reset.headers?.get?.('retry-after') ?? '?'}). Vercel overwrites ` +
        `x-forwarded-for, so a hosted deployment cannot isolate this suite - run it ` +
        `against the local harness to assert on it.`,
    )
    console.log(
      `\n  ${passed} passed, ${failed} failed` +
        (skipped > 0 ? `, ${skipped} skipped` : "") + `\n`,
    )
    if (failed > 0) process.exitCode = 1
    return
  }

  check('reset succeeds', reset.status === 200 && reset.body?.ok === true, `got ${reset.status}`)

  const oldLogin = await call('POST', '/attendee/login', {
    name: 'Qr Tester', phone: phoneQr, password: 'grid2026', remember: false,
  })
  check('old password no longer works', oldLogin.status === 401, `got ${oldLogin.status}`)

  const newLogin = await call('POST', '/attendee/login', {
    name: 'Qr Tester', phone: phoneQr, password: 'newpass2026', remember: false,
  })
  check('new password works', newLogin.status === 200, `got ${newLogin.status}`)

  // The reset must kill sessions minted by the old password.
  const staleSession = await call('GET', '/attendee/session', undefined, a.cookie)
  check('sessions from the old password are revoked', staleSession.body === null,
    `got ${JSON.stringify(staleSession.body)}`)

  /* -- reset must not become an oracle ------------------------------------- */
  const missing = await call('POST', '/attendee/password/reset', {
    phone: `7${runId}99999`.slice(0, 10), password: 'another2026',
  }, undefined, ip)
  const present = await call('POST', '/attendee/password/reset', {
    phone: phoneBare, password: 'another2026',
  }, undefined, ip)
  check('unknown number returns the same status as a known one',
    missing.status === present.status, `${missing.status} vs ${present.status}`)
  check('unknown number returns the same message as a known one',
    missing.body?.message === present.body?.message,
    `"${missing.body?.message}" vs "${present.body?.message}"`)

  const weak = await call('POST', '/attendee/password/reset', {
    phone: phoneBare, password: 'abc',
  }, undefined, ip)
  check('weak new password is rejected', weak.status === 422 && weak.body?.code === 'weak_password',
    `got ${weak.status}`)

  /* -- rate limiting -------------------------------------------------------- */
  /*
    A fresh number, so the count starts at zero.

    This is the assertion that caught the worst bug in the feature: an earlier
    version cleared a number's history on a SUCCESSFUL reset, so the count never
    reached the limit and an attacker could reset the same account forever.
    The successful attempt must consume budget.
  */
  const phoneFlood = `6${runId}33333`.slice(0, 10)

  /*
    Detect a pre-exhausted per-IP budget BEFORE asserting on the limiter.

    Vercel overwrites `x-forwarded-for` with the real client IP, so on a hosted
    deployment every caller shares one bucket and the IP budget gets consumed by
    the suite's own earlier runs - and by anyone else probing the endpoint. That
    is the limiter working correctly, but it makes these assertions report
    failures that really mean "this environment cannot host this test".

    So if the very first attempt is already blocked, the budget was spent before
    we arrived. Say so and skip rather than fail. Run this suite against the
    local harness (dev-api.mjs, no proxy in the path) to exercise the IP
    dimension for real.
  */
  const probe = await call('POST', '/attendee/password/reset', {
    phone: phoneFlood, password: 'flood2026',
  }, undefined, ip)

  if (probe.status === 429) {
    skip(
      'per-IP rate limit assertions',
      `the shared per-IP budget for this caller is already exhausted (HTTP 429, ` +
        `Retry-After ${probe.headers?.get?.('retry-after') ?? '?'}). Vercel overwrites ` +
        `x-forwarded-for, so a hosted deployment cannot isolate this test - run it ` +
        `against the local harness to assert on it.`,
    )
    console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`)
    if (failed > 0) process.exitCode = 1
    return
  }

  // The probe is itself a real attempt and consumes budget, so the flood below
  // starts from 2 of the 5/hour per-number allowance.
  let limited = 0
  let firstLimitedAt = -1
  let blockedMessage = '(none)'
  for (let i = 0; i < 8; i += 1) {
    const res = await call('POST', '/attendee/password/reset', {
      phone: phoneFlood, password: 'flood2026',
    }, undefined, ip)
    if (res.status === 429) {
      limited += 1
      if (firstLimitedAt === -1) {
        firstLimitedAt = i
        blockedMessage = res.body?.message ?? '(no message)'
      }
    }
  }
  check('per-number rate limit engages', limited > 0, `${limited}/8 were 429`)
  check('limit engages after a handful of attempts, not all of them',
    firstLimitedAt > 0 && firstLimitedAt <= 6,
    `first 429 on attempt #${firstLimitedAt + 1}` +
      (firstLimitedAt <= 0 ? ` — blocked by: ${blockedMessage}` : ''))

  const blocked = await call('POST', '/attendee/password/reset', {
    phone: phoneFlood, password: 'flood2026',
  }, undefined, ip)
  check('blocked response is 429 with rate_limited code',
    blocked.status === 429 && blocked.body?.code === 'rate_limited',
    `got ${blocked.status}/${blocked.body?.code}`)

  const retryAfter = blocked.headers?.get?.('retry-after')
  check('blocked response carries Retry-After', Boolean(retryAfter), `got ${retryAfter}`)
  console.log(`  note  Retry-After: ${retryAfter ?? 'absent'}`)

  // A different number from the same caller must still work — the per-number
  // budget must not silently become a per-IP lockout of legitimate users.
  // Must start 6-9: Indian mobiles never begin with 5.
  const other = `7${runId}44444`.slice(0, 10)
  const otherRes = await call('POST', '/attendee/password/reset', {
    phone: other, password: 'other2026',
  }, undefined, ip)
  check('a different number is unaffected by another number being blocked',
    otherRes.status === 200, `got ${otherRes.status}`)

  /* -- no admin equivalent -------------------------------------------------- */
  const adminReset = await call('POST', '/admin/password/reset', {
    username: 'admin', password: 'hacked2026',
  }, admin.cookie)
  check('no admin password-reset route exists', adminReset.status === 404, `got ${adminReset.status}`)

  console.log(
    `\n  ${passed} passed, ${failed} failed` +
      (skipped > 0 ? `, ${skipped} skipped` : "") + `\n`,
  )
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('\n  crashed:', error.message, '\n')
  process.exitCode = 1
})

