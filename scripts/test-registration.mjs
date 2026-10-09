#!/usr/bin/env node
/**
 * The generated password, the read-back, the optional change — and reading the guest
 * list back.
 *
 * Three things here are worth asserting rather than eyeballing:
 *
 *   1. THE PASSWORD IS THE PORTAL'S. Registration takes no password, and the one it
 *      issues has to satisfy the portal's own strength rule. A generator that could
 *      emit `jjj-jjj-jjj` would produce a registration that can only be completed by
 *      re-rolling, which is a bug that would only appear on the day.
 *
 *   2. THE READ-BACK IS CHECKED AGAINST THE SERVER, not just between the two boxes.
 *      The client can require the two boxes to match; it cannot notice that somebody
 *      misread the password and then faithfully typed the same wrong thing twice.
 *      This is the case that would lock somebody out of their own pass.
 *
 *   3. CHANGING YOUR OWN PASSWORD MUST NOT LOG YOU OUT. The admin password route
 *      revokes every session, which is correct there. Doing the same on the
 *      self-service route signs the attendee out of the tab they are standing in, at
 *      the moment they have just proved they know their password — indistinguishable
 *      from the portal signing people out by itself. So the session in use is kept,
 *      and that is asserted here rather than assumed.
 *
 * Plus the guest-list row reader, which is owner-only because the full list is every
 * student's name and SEN.
 *
 *   ADMIN_USERNAME / ADMIN_PASSWORD, ADMIN_PASSWORD_GATE, and DATABASE_URL.
 */

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

  const setCookie = (res.headers.getSetCookie?.() ?? []).map((l) => l.split(';')[0]).join('; ')
  const text = await res.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed, cookie: setCookie }
}

const stamp = Date.now().toString().slice(-9)

/*
  Distinct VALID phone numbers.

  Every number must begin with 6, 7, 8 or 9 — that is the rule the API enforces, and
  a bad prefix is refused as `unknown` for reasons that have nothing to do with what
  is being tested. Only four prefixes are legal, so the variation goes in the digits
  after the leading one. Zero-padded to two, because a raw concatenation plus
  truncation collapses `phoneFor(10)` onto `phoneFor(1)`.
*/
const phoneFor = (n) => `9${stamp.slice(0, 7)}${String(n).padStart(2, '0')}`

let db = null
let originalRoster = []
let originalMode = 'open'

async function restore() {
  if (!db) return
  try {
    await db.query('begin')
    await db.query('delete from event_roster')
    if (originalRoster.length > 0) {
      await db.query(
        `insert into event_roster (sen, name) select * from unnest($1::text[], $2::text[])`,
        [originalRoster.map((r) => r.sen), originalRoster.map((r) => r.name)],
      )
    }
    await db.query(
      `update events set registration_mode = $1, roster_uploaded_at = $2 where id = 'evt_awakening_2026'`,
      [originalMode, originalRoster.length > 0 ? new Date() : null],
    )
    await db.query('commit')
  } catch {
    await db.query('rollback').catch(() => {})
  }
}

async function main() {
  console.log(`\n  Testing ${BASE}\n`)

  db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()

  const { rows: before } = await db.query(
    `select registration_mode from events where id = 'evt_awakening_2026'`,
  )
  originalMode = before[0]?.registration_mode ?? 'open'
  const { rows: existing } = await db.query('select sen, name from event_roster')
  originalRoster = existing

  await db.query('delete from event_roster')
  await db.query(
    `update events set registration_mode = 'open', roster_uploaded_at = null where id = 'evt_awakening_2026'`,
  )

  const owner = await call('POST', '/admin/login', {
    username: process.env.ADMIN_USERNAME ?? 'event.control',
    password: process.env.ADMIN_PASSWORD ?? '',
  })
  check('owner signed in', owner.status === 200, `got ${owner.status}`)
  if (owner.status !== 200) {
    await restore()
    await db.end()
    report()
    return
  }

  const gate = await call('POST', '/admin/login', {
    username: 'gate',
    password: process.env.ADMIN_PASSWORD_GATE ?? '',
  })
  check('gate signed in', gate.status === 200, `got ${gate.status}`)

  /* -- the password is issued, not chosen ---------------------------------- */

  const NAME = 'Generated Password'
  const PHONE = phoneFor(1)
  const SEN = testSen(`GEN${stamp}`)

  const registered = await call('POST', '/attendee/register', {
    name: NAME,
    phone: PHONE,
    sen: SEN,
  })

  check('registration succeeds with no password in the body', registered.status === 201,
    `got ${registered.status}/${registered.body?.code}`)

  const issued = registered.body?.generatedPassword
  check('and the issued password comes back', typeof issued === 'string',
    `generatedPassword=${JSON.stringify(issued)}`)

  /*
    The shape, asserted.

    Three groups of three, and every character from an alphabet with no look-alikes:
    no `0`, `1`, `i`, `l` or `o`, because those are the characters a person cannot
    reliably read aloud over a queue and then type correctly. A credential that reads
    as `Xq7#mK2$vB` is fine for a password manager and useless at a door — one
    misheard character and the attendee is locked out with no self-service recovery.
  */
  check(
    'it is three groups of three, dash separated',
    typeof issued === 'string' && /^[a-z2-9]{3}-[a-z2-9]{3}-[a-z2-9]{3}$/.test(issued),
    `issued=${issued}`,
  )
  check(
    'and contains no character that is ambiguous when read aloud',
    typeof issued === 'string' && !/[01ilo]/.test(issued),
    `issued=${issued}`,
  )
  check(
    'and satisfies the portal strength rule: a letter and a number',
    typeof issued === 'string' && /[a-z]/.test(issued) && /[0-9]/.test(issued),
    `issued=${issued}`,
  )
  check(
    'and the hash is all that is stored — the response is the only place it exists',
    !(await db.query('select 1 from attendees where id = $1 and password_hash = $2',
      [registered.body?.attendee?.id, issued])).rowCount,
    'the plaintext is not the stored value',
  )

  const second = await call('POST', '/attendee/register', {
    name: 'Second Generated',
    phone: phoneFor(2),
    sen: testSen(`GEN${stamp}B`),
  })
  check(
    'two registrations get different passwords',
    second.status === 201 &&
      second.body?.generatedPassword !== issued &&
      typeof second.body?.generatedPassword === 'string',
    `first=${issued} second=${second.body?.generatedPassword}`,
  )

  /* -- the issued password is the one that logs in ------------------------- */

  const loginIssued = await call('POST', '/attendee/login', {
    name: NAME,
    phone: PHONE,
    password: issued,
    remember: false,
  })
  check('the issued password logs in', loginIssued.status === 200,
    `got ${loginIssued.status}/${loginIssued.body?.code}`)

  const wrongLogin = await call('POST', '/attendee/login', {
    name: NAME,
    phone: PHONE,
    password: `${issued}-x`,
    remember: false,
  })
  check('and nothing else does', wrongLogin.status === 401,
    `got ${wrongLogin.status}`)

  /* -- the read-back ------------------------------------------------------- */

  const jar = loginIssued.cookie
  check('and the session is usable', jar !== '', 'no cookie returned')

  const right = await call('POST', '/attendee/verify-password', { password: issued }, jar)
  check('the read-back accepts the right password', right.status === 200 && right.body?.matches === true,
    `got ${right.status}/${JSON.stringify(right.body)}`)

  const wrong = await call('POST', '/attendee/verify-password', { password: 'jjj-jjj-jjj' }, jar)
  check('and refuses a wrong one', wrong.status === 200 && wrong.body?.matches === false,
    `got ${wrong.status}/${JSON.stringify(wrong.body)}`)

  check(
    'a mismatch is an answer, not an error',
    wrong.status === 200,
    'it must not reuse a "credentials" code — this is the expected result of reading aloud',
  )

  /*
    THE case that justifies the server check at all.

    Somebody misreads the password, and then types the same misread version into both
    boxes. Every client-side rule passes. Only comparing against the stored hash
    catches it — and catching it here, while the real password is still on their
    screen, is the difference between a re-read and a trip to the desk.
  */
  const bothWrong = await call('POST', '/attendee/verify-password', { password: 'jjj-jjj-jjj' }, jar)
  check(
    'a password that is wrong in BOTH boxes is still caught',
    bothWrong.status === 200 && bothWrong.body?.matches === false,
    `got ${JSON.stringify(bothWrong.body)}`,
  )

  const noSession = await call('POST', '/attendee/verify-password', { password: issued })
  /*
    401, not 403. The two are different on purpose and the difference is worth holding
    onto: an attendee route with no session means "sign in again" and is recoverable by
    signing in. An admin route with no session, or with the wrong role, is 403 — there
    is nothing the caller can do about it. Writing 403 here would suggest the attendee
    could retry, and would break the convention every other attendee route follows.
  */
  check('and the read-back needs a session', noSession.status === 401, `got ${noSession.status}`)

  /* -- changing it --------------------------------------------------------- */

  const wrongCurrent = await call(
    'POST',
    '/attendee/change-password',
    { currentPassword: 'jjj-jjj-jjj', newPassword: 'kqm4tx7p982' },
    jar,
  )
  check('changing it needs the current password', wrongCurrent.status === 401,
    `got ${wrongCurrent.status}`)

  const weak = await call(
    'POST',
    '/attendee/change-password',
    { currentPassword: issued, newPassword: 'abc' },
    jar,
  )
  check('and enforces the same strength rule as the form', weak.status === 422,
    `got ${weak.status}`)

  const NEW_PASSWORD = 'kqm4tx7p982'
  const changed = await call(
    'POST',
    '/attendee/change-password',
    { currentPassword: issued, newPassword: NEW_PASSWORD },
    jar,
  )
  check('the change succeeds', changed.status === 200, `got ${changed.status}`)

  /*
    THE guarantee. The admin password route deletes every session for the attendee,
    which is right there. Doing the same here would sign the attendee out of the tab
    they are standing in, at the exact moment they have just proved they know their
    password — and it looks identical to the portal logging people out by itself.
  */
  const stillIn = await call('GET', '/attendee/session', undefined, jar)
  check(
    'and the session they are using SURVIVES the change',
    stillIn.status === 200 && stillIn.body?.attendee?.id === registered.body?.attendee?.id,
    `got ${stillIn.status}`,
  )

  const newWorks = await call('POST', '/attendee/login', {
    name: NAME, phone: PHONE, password: NEW_PASSWORD, remember: false,
  })
  check('the new password logs in', newWorks.status === 200, `got ${newWorks.status}`)

  const oldFails = await call('POST', '/attendee/login', {
    name: NAME, phone: PHONE, password: issued, remember: false,
  })
  check('and the old one no longer does', oldFails.status === 401, `got ${oldFails.status}`)

  const noSessionChange = await call('POST', '/attendee/change-password', {
    currentPassword: NEW_PASSWORD, newPassword: 'zzz11111zzz',
  })
  check('changing it needs a session', noSessionChange.status === 401, `got ${noSessionChange.status}`)

  /* -- a supplied password is still honoured ------------------------------- */

  /*
    Kept working, and validated identically. The test suites have to register a known
    password in order to log back in with it, and a client-supplied password must
    still pass the strength rule exactly as a generated one does.
  */
  const supplied = await call('POST', '/attendee/register', {
    name: 'Supplied Password',
    phone: phoneFor(3),
    sen: testSen(`SUP${stamp}`),
    password: 'fixture2026',
  })
  check('an API caller may still supply one', supplied.status === 201,
    `got ${supplied.status}/${supplied.body?.code}`)
  check(
    'and it is not echoed back as though it had been generated',
    supplied.body?.generatedPassword === undefined,
    `generatedPassword=${JSON.stringify(supplied.body?.generatedPassword)}`,
  )

  const suppliedLogin = await call('POST', '/attendee/login', {
    name: 'Supplied Password', phone: phoneFor(3), password: 'fixture2026', remember: false,
  })
  check('a supplied password is the one that logs in', suppliedLogin.status === 200,
    `got ${suppliedLogin.status}`)

  const suppliedWeak = await call('POST', '/attendee/register', {
    name: 'Weak Supplied', phone: phoneFor(4), sen: testSen(`WEK${stamp}`), password: 'abc',
  })
  check('a supplied password must still pass the strength rule', suppliedWeak.status === 422,
    `got ${suppliedWeak.status}`)

  /* -- reading the guest list back ----------------------------------------- */

  const emptyRows = await call('GET', '/admin/roster/rows', undefined, owner.cookie)
  check('the row reader answers with an empty list, not an error',
    emptyRows.status === 200 && emptyRows.body?.total === 0 && emptyRows.body?.rows?.length === 0,
    `got ${emptyRows.status}/${JSON.stringify(emptyRows.body)}`)

  const UPLOADED = [
    { name: 'Grace Hopper', sen: testSen(`GH${stamp}`) },
    { name: 'Ada Lovelace', sen: testSen(`AL${stamp}`) },
    { name: 'Katherine Johnson', sen: testSen(`KJ${stamp}`) },
  ]
  await call('POST', '/admin/roster', { rows: UPLOADED, registrationMode: 'open' }, owner.cookie)

  const rows = await call('GET', '/admin/roster/rows', undefined, owner.cookie)
  check('the owner can read every row back', rows.status === 200 && rows.body?.total === 3,
    `got ${rows.status}/${JSON.stringify(rows.body?.total)}`)
  check(
    'and gets all of them, not the eight-row sample',
    rows.body?.rows?.length === 3,
    `rows=${rows.body?.rows?.length}`,
  )
  check(
    'with the names that were actually stored',
    UPLOADED.every((u) =>
      rows.body?.rows?.some((r) => r.name === u.name && r.sen === u.sen),
    ),
    JSON.stringify(rows.body?.rows),
  )
  check(
    'and says it did not truncate, because a silent cut would look complete',
    rows.body?.truncated === false,
    `truncated=${rows.body?.truncated}`,
  )

  /*
    The reason this is a separate owner-only route rather than a bigger default.

    The full list is every student's name and SEN in one response — precisely what a
    `gate` account must never receive. `requireOwner()` runs before the query, so the
    rows are not even read for an account that may not have them.
  */
  if (gate.status === 200) {
    const gateRows = await call('GET', '/admin/roster/rows', undefined, gate.cookie)
    check('a gate account cannot read the whole list', gateRows.status === 403,
      `got ${gateRows.status}`)
  }
  const anonRows = await call('GET', '/admin/roster/rows')
  check('nor can an anonymous visitor', anonRows.status === 403, `got ${anonRows.status}`)

  /* -- the panel keeps the default cheap ----------------------------------- */

  const summary = await call('GET', '/admin/roster', undefined, owner.cookie)
  check(
    'the default read is still a count and a sample, not the whole list',
    Array.isArray(summary.body?.sample) && summary.body.sample.length <= 8,
    `sample=${summary.body?.sample?.length}`,
  )

  await purgeTestAttendees(db)
  await restore()
  await db.end()
  report()
}

main().catch(async (error) => {
  console.error('\n  crashed:', error.message, '\n')
  try {
    await purgeTestAttendees(db)
    await restore()
    if (db) await db.end()
  } catch {
    // The cleanup failure must not mask the real error.
  }
  process.exitCode = 1
})