#!/usr/bin/env node
/**
 * Staff roles: who can do what, and that the server is the one saying no.
 *
 * This is the suite that matters most for the `gate` role, because a permission
 * bug is invisible everywhere else. The tab bar still renders, the scan still
 * works, the log still loads — and whoever is on the door quietly walks away with
 * the whole roster. So every restriction is asserted on the ROUTE, not on the
 * UI, and the negative cases are checked explicitly rather than inferred from the
 * positives.
 *
 * The accounts are provisioned straight into the database, because there is no
 * longer an API that creates them. That is the same path `scripts/manage-staff.mjs`
 * uses, so a green run means the real provisioning path produces an account the
 * real server then respects.
 *
 *   ADMIN_USERNAME / ADMIN_PASSWORD in the environment, or in .env.
 */

import { execFileSync } from 'node:child_process'
import { Client } from 'pg'
import { loadEnv } from './_env.mjs'
import { testSen, purgeTestAttendees } from './_fixtures.mjs'

loadEnv()

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'

let passed = 0
let failed = 0

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function report() {
  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
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
  return { status: res.status, body: parsed, cookie: setCookie }
}

/** Digits only: this stamp also builds a phone number. */
const stamp = Date.now().toString().slice(-9)
const GATE_USER = `role-probe-${stamp}`
const OWNER_USER = `role-probe-owner-${stamp}`
const PROBE_PASSWORD = 'probe2026pass'

let db = null

async function purge() {
  if (!db) return false
  for (const username of [GATE_USER, OWNER_USER]) {
    const { rows } = await db.query('select id from admins where username = $1', [username])
    for (const row of rows) {
      await db.query(`delete from sessions where kind = 'admin' and subject_id = $1`, [row.id])
      await db.query('delete from staff_changes where subject_id = $1 or admin_id = $1', [row.id])
    }
    await db.query('delete from admins where username = $1', [username])
  }
  /*
    The scan fixture too, not just the staff accounts.

    This purge originally handled admins only, so the "Gate Probe" attendee it
    registered survived every run — on the real roster, with an attendance mark
    beside a name nobody recognised.
  */
  await purgeTestAttendees(db)
  return true
}

/**
 * Provisions an account by running the real CLI, and returns its password.
 *
 * Not an INSERT. The whole point of removing the Staff panel was that
 * provisioning now happens through `manage-staff.mjs`, so a suite that wrote the
 * row itself would be testing a path nothing actually uses — and the audit trail
 * it would then assert on would never have been written by anything.
 */
function provisionViaCli(username, displayName, role) {
  const out = execFileSync(
    process.execPath,
    ['scripts/manage-staff.mjs', 'add', username, displayName, role],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const match = out.match(/^\s*password\s+(\S+)\s*$/m)
  if (!match) throw new Error(`manage-staff.mjs printed no password:\n${out}`)
  return match[1]
}

async function main() {
  console.log(`\n  Testing ${BASE}\n`)

  if (!process.env.DATABASE_URL) {
    console.log('  DATABASE_URL is not set — cannot provision the probe accounts.\n')
    process.exitCode = 1
    return
  }
  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await db.connect()
  await purge()

  /* -- provision, through the CLI that replaced the Staff panel -------------- */
  const gatePassword = provisionViaCli(GATE_USER, 'Role Probe', 'gate')
  check('the CLI provisions a gate account', typeof gatePassword === 'string' && gatePassword.length >= 8)

  const duplicate = (() => {
    try {
      execFileSync(
        process.execPath,
        ['scripts/manage-staff.mjs', 'add', GATE_USER, 'Duplicate', 'owner'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      return 'accepted it'
    } catch (error) {
      return String(error.stderr ?? '')
    }
  })()
  check(
    'the CLI refuses a duplicate username',
    /already exists/i.test(duplicate),
    duplicate.trim(),
  )

  // A second owner, so the "last owner" guard can be observed rather than assumed.
  const ownerPassword = provisionViaCli(OWNER_USER, 'Probe Owner', 'owner')

  /* -- the owner signs in --------------------------------------------------- */
  const owner = await call('POST', '/admin/login', {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? '',
  })
  check('the owner signs in', owner.status === 200, `got ${owner.status}`)

  if (owner.status !== 200) {
    console.log('  ADMIN_PASSWORD is not set. Export it, or run against a local .env.\n')
    await purge()
    await db.end()
    process.exitCode = 1
    return
  }

  check(
    'the owner session reports the full-access role',
    owner.body?.admin?.role === 'owner',
    `role=${owner.body?.admin?.role}`,
  )

  /* -- the gate account signs in -------------------------------------------- */
  const gate = await call('POST', '/admin/login', {
    username: GATE_USER,
    password: gatePassword,
  })
  check('the gate account signs in', gate.status === 200, `got ${gate.status}`)
  check(
    'the gate session reports the gate role',
    gate.body?.admin?.role === 'gate',
    `role=${gate.body?.admin?.role}`,
  )

  const gateSession = await call('GET', '/admin/session', undefined, gate.cookie)
  check(
    'the role survives a page refresh, which is what this endpoint is for',
    gateSession.body?.admin?.role === 'gate',
    JSON.stringify(gateSession.body),
  )
  check(
    'the owner role also survives a refresh',
    (await call('GET', '/admin/session', undefined, owner.cookie)).body?.admin?.role === 'owner',
  )

  /* -- what a gate account may do ------------------------------------------- */
  check(
    'a gate account can read teams',
    (await call('GET', '/teams')).status === 200,
  )

  const gateLog = await call('GET', '/admin/attendance', undefined, gate.cookie)
  check('a gate account can read the attendance log', gateLog.status === 200, `got ${gateLog.status}`)
  check(
    'the log carries the attendee name, so no roster is needed to read it',
    Array.isArray(gateLog.body) &&
      gateLog.body.every((row) => typeof row.attendeeName === 'string'),
    JSON.stringify(gateLog.body?.[0]),
  )

  /* -- what a gate account may not do --------------------------------------- */
  /*
    Each of these is the actual control. Hiding a tab is presentation; the route
    refusing is the permission. Somebody at the door with devtools open gets 403 on
    every one of them.
  */
  const denied = [
    ['GET', '/admin/attendees', undefined, 'the roster'],
    ['POST', '/admin/attendees/password', { sen: 'A866175000000', password: PROBE_PASSWORD }, 'changing a password'],
    ['PATCH', '/admin/event', { phase: 'live' }, 'the event phase'],
    ['PATCH', '/admin/agenda/ag_01', { status: 'live' }, 'the agenda'],
  ]

  for (const [method, path, body, what] of denied) {
    const res = await call(method, path, body, gate.cookie)
    check(
      `a gate account cannot touch ${what}`,
      res.status === 403,
      `${method} ${path} -> ${res.status}/${res.body?.code}`,
    )
  }

  check(
    'there is no route that manages staff accounts',
    denied.length > 0 &&
      (await call('GET', '/admin/staff', undefined, gate.cookie)).status === 404,
    'the Staff panel was removed; its routes should be gone, not merely locked',
  )
  check(
    'nor one that creates them, even for an owner',
    (await call('POST', '/admin/staff', {}, owner.cookie)).status === 404,
  )

  /* -- a gate account can still scan ----------------------------------------- */
  const senScan = testSen(`SCAN${stamp}`)
  // Ten digits, starting 6-9: Indian mobiles never begin with 5.
  const phoneScan = `7${stamp}`.slice(0, 10).padEnd(10, '4')
  const reg = await call('POST', '/attendee/register', {
    name: 'Gate Probe',
    phone: phoneScan,
    sen: senScan,
    password: PROBE_PASSWORD,
  })
  check('registered a scan fixture', reg.status === 201, `got ${reg.status}`)

  const scan = await call('POST', '/admin/attendance', { sen: senScan }, gate.cookie)
  check(
    'a gate account CAN mark attendance',
    scan.status === 201 && scan.body?.method !== undefined,
    `got ${scan.status}`,
  )
  check(
    'the scan response names the attendee, which is all the desk needs',
    scan.body?.attendee?.name === 'Gate Probe',
    JSON.stringify(scan.body?.attendee?.name),
  )
  check(
    'a duplicate scan is refused as already checked in',
    (await call('POST', '/admin/attendance', { sen: senScan }, gate.cookie)).status === 409,
  )

  /* -- the owner can still do everything ------------------------------------- */
  for (const [method, path, what] of [
    ['GET', '/admin/attendees', 'the roster'],
    ['PATCH', '/admin/event', 'the event phase'],
  ]) {
    const body = method === 'PATCH' ? { phase: 'registration' } : undefined
    const res = await call(method, path, body, owner.cookie)
    check(`an owner can still touch ${what}`, res.status === 200, `got ${res.status}`)
  }

  /* -- an unrecognised role must fail CLOSED -------------------------------- */
  /*
    The CHECK constraint stops the database storing a third value, so this is
    reached by dropping the constraint rather than through the API. It is the
    assertion that matters most of all of them: `adminRole` decides what an
    unrecognised value means, and treating it as `owner` would be a silent
    privilege escalation the moment anyone widened the role list.
  */
  await db.query('alter table admins drop constraint if exists admins_role')
  await db.query(`update admins set role = 'superuser' where username = $1`, [GATE_USER])
  const escalated = await call('POST', '/admin/login', {
    username: GATE_USER,
    password: gatePassword,
  })
  check(
    'an account with an unrecognised role is treated as gate, not owner',
    escalated.status === 200 && escalated.body?.admin?.role === 'gate',
    `role=${escalated.body?.admin?.role}`,
  )
  check(
    'and is refused the roster',
    (await call('GET', '/admin/attendees', undefined, escalated.cookie)).status === 403,
  )
  await db.query(`update admins set role = 'gate' where username = $1`, [GATE_USER])
  await db.query(
    `alter table admins add constraint admins_role check (role in ('owner', 'gate'))`,
  )

  /* -- a disabled account is signed out -------------------------------------- */
  /* -- a disabled account is signed out -------------------------------------- */
  const correctPassword = await call('POST', '/admin/login', {
    username: OWNER_USER,
    password: ownerPassword,
  })
  check(
    'the probe owner can sign in while active',
    correctPassword.status === 200,
    `got ${correctPassword.status}`,
  )

  execFileSync(process.execPath, ['scripts/manage-staff.mjs', 'disable', OWNER_USER], {
    encoding: 'utf8',
    stdio: 'ignore',
  })
  const { rows: afterDisable } = await db.query(
    'select active from admins where username = $1',
    [OWNER_USER],
  )
  check(
    'the CLI can disable an account while other owners exist',
    afterDisable[0]?.active === false,
    `active=${afterDisable[0]?.active}`,
  )

  const disabledLogin = await call('POST', '/admin/login', {
    username: OWNER_USER,
    password: ownerPassword,
  })
  check(
    'a disabled account cannot sign in',
    disabledLogin.status === 401,
    `got ${disabledLogin.status}`,
  )
  check(
    'and is refused exactly as a wrong password is',
    (await call('POST', '/admin/login', { username: OWNER_USER, password: 'x' })).status ===
      disabledLogin.status,
    'a distinguishable response turns the login form into a username oracle',
  )

  /*
    A session minted before the account was switched off must be dead the moment
    it is, not whenever the cookie happens to expire — which is why `disable`
    deletes the account's sessions.
  */
  check(
    'a session taken before the account was disabled is revoked',
    (await call('GET', '/admin/attendees', undefined, correctPassword.cookie)).status === 403,
  )

  execFileSync(process.execPath, ['scripts/manage-staff.mjs', 'enable', OWNER_USER], {
    encoding: 'utf8',
    stdio: 'ignore',
  })
  check(
    'the CLI can switch it back on',
    (
      await db.query('select active from admins where username = $1', [OWNER_USER])
    ).rows[0]?.active === true,
  )

  execFileSync(process.execPath, ['scripts/manage-staff.mjs', 'enable', OWNER_USER], {
    encoding: 'utf8',
    stdio: 'ignore',
  })

  /* -- the audit trail ------------------------------------------------------- */
  const { rows } = await db.query(
    `select sc.action, sc.detail from staff_changes sc where sc.subject_id =
       (select id from admins where username = $1) order by sc.at`,
    [OWNER_USER],
  )
  check(
    'provisioning is recorded in the audit trail',
    rows.some((row) => row.action === 'created'),
    rows.map((row) => row.action).join(', '),
  )
  check(
    'a deactivation is recorded too',
    rows.some((row) => row.action === 'deactivated'),
    rows.map((row) => row.action).join(', '),
  )

  /* -- cleanup --------------------------------------------------------------- */
  check('test accounts removed', await purge())

  await db.end()
  report()
}

main().catch(async (error) => {
  console.error('\n  crashed:', error.message, '\n')
  try {
    await purge()
    if (db) await db.end()
  } catch {
    // The cleanup failure must not mask the original error.
  }
  process.exitCode = 1
})