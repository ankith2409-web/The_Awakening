#!/usr/bin/env node
/**
 * Focused checks for the two features that changed most recently: the gate's
 * signature verification, and password recovery.
 *
 * Run against a live API:  node scripts/test-gate-and-reset.mjs
 *
 * Set ADMIN_USERNAME / ADMIN_PASSWORD for a hosted deployment. The audit-trail
 * assertions additionally read the database directly, so export DATABASE_URL to
 * include them — without it they skip rather than fail.
 */

import { Client } from 'pg'
import { loadEnv } from './_env.mjs'
import { testSen, purgeTestAttendeesOnce } from './_fixtures.mjs'

loadEnv()

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
 * Reads the audit trail for one SEN, newest first.
 *
 * Resolves to `null` when there is no database to ask, which the caller reports
 * as a skip. A missing DATABASE_URL is an environment fact, not a failure of the
 * portal — and a suite that fails for that reason teaches people to ignore it.
 */
async function auditRowsFor(sen) {
  const url = process.env.DATABASE_URL
  if (!url) return null

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  try {
    await client.connect()
    const { rows } = await client.query(
      `select pc.admin_id, pc.at
         from password_changes pc
         join attendees a on a.id = pc.attendee_id
        where upper(a.sen) = upper($1)
        order by pc.at desc`,
      [sen],
    )
    return rows
  } finally {
    await client.end()
  }
}

async function call(method, path, body, cookie) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'

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
    Per-run identifiers, so back-to-back runs do not collide on the unique index
    on phone and SEN. The ZTEST prefix is what lets the cleanup at the end find
    them again — the previous convention ("fixtures the cleanup script
    recognises by name") relied on somebody running that script by hand, which is
    why these two ended up on the live roster.
  */
  const senQr = testSen(`Q${runId}`)
  const senBare = testSen(`B${runId}`)
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

  /* -- password recovery is admin-mediated ---------------------------------- */
  /*
    These assertions are shaped around absence as much as presence.

    The public reset endpoint used to accept a phone number and a new password
    with no verification of any kind: no OTP, no email, no security question.
    Knowing someone's number was therefore enough to take over their account
    and present their pass at the gate. It was the most serious weakness the
    portal had, and it was under active probing in production.

    The fix was to delete it, not to tighten it — so the first assertion here is
    that it is gone. If a future change reintroduces an unauthenticated reset,
    this fails, which is the only place in the codebase that would notice.
  */
  const publicReset = await call('POST', '/attendee/password/reset', {
    phone: phoneQr, password: 'sneaky2026',
  })
  check('the self-service reset endpoint no longer exists',
    publicReset.status === 404, `got ${publicReset.status}`)

  // Proves the 404 is a real removal rather than a 404 raised after the write.
  const untouched = await call('POST', '/attendee/login', {
    name: 'Qr Tester', phone: phoneQr, password: 'grid2026', remember: false,
  })
  check('the removed endpoint did not change the password on its way out',
    untouched.status === 200, `got ${untouched.status}`)

  /* -- the door is shut to unauthenticated callers --------------------------- */
  const noSession = await call('POST', '/admin/attendees/password', {
    sen: senQr, password: 'sneaky2026',
  })
  check('an unauthenticated caller cannot change a password',
    noSession.status === 403, `got ${noSession.status}`)

  const garbage = await call('POST', '/admin/attendees/password', {
    sen: '!!', password: 'grid2026',
  }, admin.cookie)
  check('a malformed SEN is rejected before any lookup',
    garbage.status === 422 && garbage.body?.code === 'unknown_sen',
    `got ${garbage.status}/${garbage.body?.code}`)

  const unregistered = await call('POST', '/admin/attendees/password', {
    sen: `SEN${runId}ZZ`, password: 'grid2026',
  }, admin.cookie)
  check('an unregistered SEN is refused',
    unregistered.status === 422 && unregistered.body?.code === 'unknown_sen',
    `got ${unregistered.status}/${unregistered.body?.code}`)

  /*
    An admin cannot set a weaker password than a self-registering attendee could
    choose. Otherwise "ask the organiser" becomes a downgrade path: the rule
    exists on the registration form and it has to exist here too, or the desk
    becomes the easy way in.
  */
  const weak = await call('POST', '/admin/attendees/password', {
    sen: senQr, password: 'abc',
  }, admin.cookie)
  check('an admin cannot set a password registration would have refused',
    weak.status === 422 && weak.body?.code === 'weak_password',
    `got ${weak.status}/${weak.body?.code}`)

  /* -- the admin can do the thing it exists for ------------------------------ */
  const changed = await call('POST', '/admin/attendees/password', {
    sen: senQr, password: 'newpass2026',
  }, admin.cookie)
  check('the admin can set a password for a registered attendee',
    changed.status === 200 && changed.body?.attendee?.sen === senQr,
    `got ${changed.status}/${changed.body?.attendee?.sen}`)
  check('the response names the attendee it acted on',
    changed.body?.attendee?.name === 'Qr Tester',
    `got ${changed.body?.attendee?.name}`)
  check('the response reports that sessions were revoked',
    changed.body?.sessionsRevoked === true,
    `got ${changed.body?.sessionsRevoked}`)

  const staleSession = await call('GET', '/attendee/session', undefined, a.cookie)
  check('a session from the previous password is revoked',
    staleSession.body === null, `got ${JSON.stringify(staleSession.body)}`)

  const oldLogin = await call('POST', '/attendee/login', {
    name: 'Qr Tester', phone: phoneQr, password: 'grid2026', remember: false,
  })
  check('the previous password no longer works',
    oldLogin.status === 401, `got ${oldLogin.status}`)

  const newLogin = await call('POST', '/attendee/login', {
    name: 'Qr Tester', phone: phoneQr, password: 'newpass2026', remember: false,
  })
  check('the new password works', newLogin.status === 200, `got ${newLogin.status}`)

  /*
    An organiser reading a badge aloud types the SEN however they heard it, and
    the gate's scanner receives it however the phone's camera decoded it. The
    lookup normalises before comparing, so a lowercase SEN must land on the same
    attendee — otherwise the desk tells someone their own number is unknown.
  */
  const lowercase = await call('POST', '/admin/attendees/password', {
    sen: senQr.toLowerCase(), password: 'newpass2026',
  }, admin.cookie)
  check('the SEN is matched case-insensitively',
    lowercase.status === 200 && lowercase.body?.attendee?.sen === senQr,
    `got ${lowercase.status}/${lowercase.body?.attendee?.sen}`)

  /* -- the change is attributable ------------------------------------------- */
  /*
    Reached with the database rather than over HTTP because that is the only
    place the audit trail is readable, and the point of this check is precisely
    that it is not exposed over the API.

    A privileged credential change with no record of who authorised it is a much
    weaker thing to be able to hand to an attendee who disputes one.
  */
  const audit = await auditRowsFor(senQr)
  if (audit === null) {
    skip(
      'the password-change audit trail',
      'DATABASE_URL is not set, so the audit table cannot be read from here. ' +
        'Run with it exported to assert on this.',
    )
  } else {
    check('each successful change is recorded', audit.length >= 2,
      `${audit.length} row(s) — expected at least 2 (the set, plus the case test)`)
    check('the audit trail names the admin who authorised it',
      audit.length > 0 && audit.every((row) => typeof row.admin_id === 'string' && row.admin_id !== ''),
      JSON.stringify(audit.map((row) => row.admin_id)))
    check('the audit trail is stamped with a time',
      audit.length > 0 && audit.every((row) => !Number.isNaN(Date.parse(row.at))),
      JSON.stringify(audit.map((row) => row.at)))
    check('the recorded admin is the one that signed in',
      audit.length > 0 && audit.every((row) => row.admin_id === admin.body?.admin?.id),
      `${audit[0]?.admin_id} vs ${admin.body?.admin?.id}`)
  }

  /* -- staff credentials still have no recovery route ----------------------- */
  const adminReset = await call('POST', '/admin/password/reset', {
    username: 'admin', password: 'hacked2026',
  }, admin.cookie)
  check('no admin password-reset route exists',
    adminReset.status === 404, `got ${adminReset.status}`)

  // Both fixtures are removed, on every exit path. They were registered against
  // the live database and marked present by the scan tests below.
  await purgeTestAttendeesOnce()

  console.log(
    `\n  ${passed} passed, ${failed} failed` +
      (skipped > 0 ? `, ${skipped} skipped` : "") + `\n`,
  )
  if (failed > 0) process.exitCode = 1
}

main().catch(async (error) => {
  console.error('\n  crashed:', error.message, '\n')
  try {
    await purgeTestAttendeesOnce()
  } catch {
    // Never let the cleanup failure mask the real error.
  }
  process.exitCode = 1
})

