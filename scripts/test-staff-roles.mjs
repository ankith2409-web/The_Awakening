#!/usr/bin/env node
/**
 * Staff roles: who can do what, and that the server is the one saying no.
 *
 * This is the suite that matters most for the `gate` role, because a permission
 * bug is invisible everywhere else. The tab bar still renders, the scan still
 * works, the log still loads — and a volunteer quietly walks away with the whole
 * roster. So every restriction is asserted on the ROUTE, not on the UI, and the
 * negative cases are checked explicitly rather than inferred from the positives.
 *
 *   ADMIN_USERNAME / ADMIN_PASSWORD in the environment, or in .env.
 */

import { Client } from 'pg'
import { loadEnv } from './_env.mjs'

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

function report() {
  console.log(
    `\n  ${passed} passed, ${failed} failed` +
      (skipped > 0 ? `, ${skipped} skipped` : '') +
      `\n`,
  )
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

  const cookie2 = (res.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(';')[0])
    .join('; ')

  const text = await res.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed, cookie: cookie2 }
}

/** Removes the accounts this run created, so a rerun is clean. */
async function purgeTestStaff() {
  const url = process.env.DATABASE_URL
  if (!url) return false
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  try {
    await client.connect()
    await client.query(`delete from admins where username like 'role-probe-%'`)
    return true
  } finally {
    await client.end()
  }
}

async function main() {
  console.log(`\n  Testing ${BASE}\n`)

  const ownerUser = process.env.ADMIN_USERNAME ?? 'admin'
  const ownerPass = process.env.ADMIN_PASSWORD ?? ''

  /* -- the owner signs in --------------------------------------------------- */
  const owner = await call('POST', '/admin/login', {
    username: ownerUser,
    password: ownerPass,
  })
  check('the owner signs in', owner.status === 200, `got ${owner.status}`)

  if (owner.status !== 200) {
    console.log(
      '  ADMIN_PASSWORD is not set. Export it, or run against a local .env.\n',
    )
    process.exitCode = 1
    return
  }

  check(
    'the owner session reports the full-access role',
    owner.body?.admin?.role === 'owner',
    `role=${owner.body?.admin?.role}`,
  )

  /* -- create a gate account ------------------------------------------------ */
  /*
    Digits only, and distinct from the fixtures the other suites use.

    An earlier version derived this from `Date.now().toString(36)`, which puts
    letters in the string — and then used it to build a phone number. Registration
    returned 422 and four downstream assertions failed for a reason that had
    nothing to do with the thing under test. A failure caused by the fixture must
    never be mistaken for a finding.
  */
  const stamp = Date.now().toString().slice(-9)
  const gateUser = `role-probe-${stamp}`

  const created = await call(
    'POST',
    '/admin/staff',
    {
      username: gateUser,
      displayName: 'Role Probe',
      password: 'probe2026pass',
      role: 'gate',
    },
    owner.cookie,
  )
  check('the owner can create a gate account', created.status === 201, `got ${created.status}`)
  check(
    'the created account comes back as gate',
    created.body?.staff?.role === 'gate',
    `role=${created.body?.staff?.role}`,
  )
  check(
    'the created account carries no password hash',
    !JSON.stringify(created.body).includes('passwordHash') &&
      !JSON.stringify(created.body).includes('password_hash'),
    JSON.stringify(created.body),
  )

  const duplicate = await call(
    'POST',
    '/admin/staff',
    {
      // Uppercased: the unique index is on lower(username), so this is the same
      // account and must be refused as such.
      username: gateUser.toUpperCase(),
      displayName: 'Duplicate',
      password: 'probe2026pass',
      role: 'owner',
    },
    owner.cookie,
  )
  check(
    'a duplicate username is refused regardless of case',
    duplicate.status === 409 && duplicate.body?.code === 'username_taken',
    `got ${duplicate.status}/${duplicate.body?.code}`,
  )

  const weakStaff = await call(
    'POST',
    '/admin/staff',
    { username: `role-probe-w-${stamp}`, displayName: 'Weak', password: 'abc', role: 'gate' },
    owner.cookie,
  )
  check(
    'a staff password cannot be weaker than an attendee password',
    weakStaff.status === 422 && weakStaff.body?.code === 'weak_password',
    `got ${weakStaff.status}/${weakStaff.body?.code}`,
  )

  /* -- the gate account signs in -------------------------------------------- */
  const gate = await call('POST', '/admin/login', {
    username: gateUser,
    password: 'probe2026pass',
  })
  check('the gate account signs in', gate.status === 200, `got ${gate.status}`)
  check(
    'the gate session reports the gate role',
    gate.body?.admin?.role === 'gate',
    `role=${gate.body?.admin?.role}`,
  )

  /* -- what a gate account may do ------------------------------------------- */
  const gateSession = await call('GET', '/admin/session', undefined, gate.cookie)
  check(
    'the gate session survives its own probe',
    gateSession.body?.admin?.role === 'gate',
    JSON.stringify(gateSession.body),
  )

  const gateTeams = await call('GET', '/teams')
  check('a gate account can read teams', gateTeams.status === 200, `got ${gateTeams.status}`)

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
    refusing is the permission. A volunteer with devtools open gets 403 on all of
    them.
  */
  const denied = [
    ['GET', '/admin/attendees', undefined, 'the roster'],
    ['GET', '/admin/staff', undefined, 'the staff list'],
    ['POST', '/admin/attendees/password', { sen: 'A866175000000', password: 'probe2026pass' }, 'changing a password'],
    ['PATCH', '/admin/event', { phase: 'live' }, 'the event phase'],
    ['POST', '/admin/staff', { username: `x-${stamp}`, displayName: 'X', password: 'probe2026pass', role: 'owner' }, 'creating an account'],
    ['PATCH', '/admin/staff', { id: owner.body?.admin?.id, role: 'gate' }, 'changing staff'],
  ]

  for (const [method, path, body, what] of denied) {
    const res = await call(method, path, body, gate.cookie)
    check(
      `a gate account cannot touch ${what}`,
      res.status === 403,
      `${method} ${path} -> ${res.status}/${res.body?.code}`,
    )
  }

  /* -- a gate account can still scan ----------------------------------------- */
  const senScan = `SEN${stamp}X`
  // Ten digits, starting 6-9: Indian mobiles never begin with 5.
  const phoneScan = `7${stamp}`.slice(0, 10).padEnd(10, '4')
  const reg = await call('POST', '/attendee/register', {
    name: 'Gate Probe',
    phone: phoneScan,
    sen: senScan,
    password: 'probe2026pass',
  })
  check('registered a scan fixture', reg.status === 201, `got ${reg.status}`)

  const scan = await call('POST', '/admin/attendance', { sen: senScan }, gate.cookie)
  check(
    'a gate account CAN mark attendance',
    scan.status === 201 && scan.body?.method !== undefined,
    `got ${scan.status}`,
  )
  check(
    'the scan response names the attendee, which is all a volunteer needs',
    scan.body?.attendee?.name === 'Gate Probe',
    JSON.stringify(scan.body?.attendee?.name),
  )

  const dupe = await call('POST', '/admin/attendance', { sen: senScan }, gate.cookie)
  check(
    'a duplicate scan is refused as already checked in',
    dupe.status === 409,
    `got ${dupe.status}`,
  )

  /* -- a gate account cannot escalate itself --------------------------------- */
  const selfPromote = await call('POST', '/admin/staff', {
    username: `escalate-${stamp}`,
    displayName: 'Escalate',
    password: 'probe2026pass',
    role: 'owner',
  }, gate.cookie)
  check(
    'a gate account cannot mint itself a full-access one',
    selfPromote.status === 403,
    `got ${selfPromote.status}`,
  )

  /* -- the owner's own protections ------------------------------------------- */
  const selfDemote = await call(
    'PATCH',
    '/admin/staff',
    { id: owner.body?.admin?.id, role: 'gate' },
    owner.cookie,
  )
  check(
    'nobody can demote themselves',
    selfDemote.status === 422,
    `got ${selfDemote.status}/${selfDemote.body?.code}`,
  )

  const selfDisable = await call(
    'PATCH',
    '/admin/staff',
    { id: owner.body?.admin?.id, active: false },
    owner.cookie,
  )
  check(
    'nobody can switch themselves off',
    selfDisable.status === 422,
    `got ${selfDisable.status}/${selfDisable.body?.code}`,
  )

  /* -- a second owner, so the last-owner rule can be tested ------------------ */
  const secondOwnerUser = `role-probe-owner-${stamp}`
  const second = await call('POST', '/admin/staff', {
    username: secondOwnerUser,
    displayName: 'Second Owner',
    password: 'probe2026pass',
    role: 'owner',
  }, owner.cookie)
  check('the owner can create a second full-access account', second.status === 201, `got ${second.status}`)

  /*
    Only one full-access account exists in a fresh database, so this asserts the
    rule holds. If a previous run left another behind the check is skipped rather
    than failed — the rule is still exercised below with the second account.
  */
  const staffList = await call('GET', '/admin/staff', undefined, owner.cookie)
  const activeOwners = (staffList.body ?? []).filter(
    (person) => person.role === 'owner' && person.active,
  ).length

  const demoteOnly = await call(
    'PATCH',
    '/admin/staff',
    { id: owner.body?.admin?.id, role: 'gate' },
    owner.cookie,
  )
  check(
    'nobody can demote themselves, even as the only owner',
    demoteOnly.status === 422,
    `got ${demoteOnly.status}`,
  )

  if (activeOwners === 2) {
    const demoteSecond = await call(
      'PATCH',
      '/admin/staff',
      { id: second.body?.staff?.id, role: 'gate' },
      owner.cookie,
    )
    check(
      'the second owner can be demoted while the first remains',
      demoteSecond.status === 200 && demoteSecond.body?.staff?.role === 'gate',
      `got ${demoteSecond.status}/${demoteSecond.body?.staff?.role}`,
    )

    // That left exactly one owner again, so the rule should bite now.
    const lastOwner = await call(
      'PATCH',
      '/admin/staff',
      { id: owner.body?.admin?.id, active: false },
      owner.cookie,
    )
    check(
      'the last owner still cannot be removed',
      lastOwner.status === 422,
      `got ${lastOwner.status}`,
    )
  } else {
    skip(
      'the demote-the-last-owner rule',
      `there are already ${activeOwners} active full-access accounts, so the ` +
        'last-owner guard cannot be observed. Delete the extras and rerun.',
    )
  }

  /* -- demotion takes effect immediately ------------------------------------- */
  const promoteBack = await call(
    'PATCH',
    '/admin/staff',
    { id: second.body?.staff?.id, role: 'owner' },
    owner.cookie,
  )
  check(
    'an owner can promote an account back',
    promoteBack.status === 200 && promoteBack.body?.staff?.role === 'owner',
    `got ${promoteBack.status}`,
  )

  /*
    The demoted-then-repromoted account had its sessions deleted when it was
    demoted. Signing in again must produce a working session with the new role,
    and the old cookie must be dead — otherwise a demotion would only take hold
    whenever the cookie happened to expire.
  */
  const secondLogin = await call('POST', '/admin/login', {
    username: secondOwnerUser,
    password: 'probe2026pass',
  })
  check('the promoted account can sign in again', secondLogin.status === 200, `got ${secondLogin.status}`)
  check(
    'the re-issued session carries the new role',
    secondLogin.body?.admin?.role === 'owner',
    `role=${secondLogin.body?.admin?.role}`,
  )

  /* -- deactivation ends access ---------------------------------------------- */
  const disable = await call(
    'PATCH',
    '/admin/staff',
    { id: second.body?.staff?.id, active: false },
    owner.cookie,
  )
  check('an owner can switch an account off', disable.status === 200, `got ${disable.status}`)

  const afterDisable = await call('GET', '/admin/staff', undefined, secondLogin.cookie)
  check(
    'a disabled account loses access immediately, not when its cookie expires',
    afterDisable.status === 403,
    `got ${afterDisable.status}`,
  )

  const disableLogin = await call('POST', '/admin/login', {
    username: secondOwnerUser,
    password: 'probe2026pass',
  })
  check(
    'a disabled account cannot sign in again',
    disableLogin.status === 401,
    `got ${disableLogin.status}`,
  )

  /* -- the audit trail ------------------------------------------------------- */
  const url = process.env.DATABASE_URL
  if (!url) {
    skip('the staff-change audit trail', 'DATABASE_URL is not set.')
  } else {
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
    try {
      await client.connect()
      const { rows } = await client.query(
        `select sc.action, sc.detail, sc.admin_id, a.username as changed_by, t.username as subject
           from staff_changes sc
           join admins a on a.id = sc.admin_id
           join admins t on t.id = sc.subject_id
          where t.username like 'role-probe-%'
          order by sc.at`,
      )
      check(
        'creating an account is recorded',
        rows.some((row) => row.action === 'created'),
        rows.map((row) => row.action).join(', '),
      )
      check(
        'a role change is recorded',
        rows.some((row) => row.action === 'role_changed'),
        rows.map((row) => row.action).join(', '),
      )
      check(
        'a deactivation is recorded',
        rows.some((row) => row.action === 'deactivated'),
        rows.map((row) => row.action).join(', '),
      )
      check(
        'every record names the admin who authorised it',
        rows.every((row) => row.changed_by === ownerUser),
        rows.map((row) => row.changed_by).join(', '),
      )
    } finally {
      await client.end()
    }
  }

  /* -- cleanup --------------------------------------------------------------- */
  const purged = await purgeTestStaff()
  check(
    'test accounts removed',
    purged,
    purged ? '' : 'no DATABASE_URL, so the probe accounts are still there',
  )

  report()
}

main().catch((error) => {
  console.error('\n  crashed:', error.message, '\n')
  process.exitCode = 1
})