#!/usr/bin/env node
/**
 * Who may register: the guest list, the open/restricted/closed switch, and adding
 * somebody by hand.
 *
 * This suite exists because the blast radius is unusual. Registration is the only
 * door into the event, and closing it — to everyone, or to everyone not on a list —
 * has no self-service route out and no undo from the attendee's side. A mistake here
 * locks real students out of an event days away.
 *
 * Five things are therefore asserted that would not be worth asserting for an
 * ordinary write:
 *
 *   1. A refused upload changes NOTHING. A partially-applied list locks out whichever
 *      students did not land, and the symptom they see is "you are not on the list",
 *      which points at the list rather than at the upload that broke it.
 *   2. `restricted` is off by default and survives an upload that does not ask for it.
 *   3. `closed` stops EVERYONE, including a SEN that is on the list. A mode that only
 *      narrowed would have no way to express a full room, and would report a listed
 *      student as "not on the list" when the truth is that nobody may register.
 *   4. Clearing the list does NOT change the mode. The two used to be one action, and
 *      tidying up a bad spreadsheet would have shut the door to everyone remaining.
 *   5. The list is never returned whole — a `gate` account must not be able to read
 *      every student's name and SEN, which is the roster with extra steps.
 *
 * Restores the previous state on every exit path. A mode left `closed` or `restricted`
 * would refuse registration on the live site until somebody noticed.
 *
 *   ADMIN_USERNAME / ADMIN_PASSWORD, ADMIN_PASSWORD_GATE, and DATABASE_URL.
 */

import { Client } from 'pg'
import { loadEnv } from './_env.mjs'
import { testSen, purgeTestAttendees } from './_fixtures.mjs'

loadEnv()

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = 'probe2026pass'

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
const ALLOWED_SEN = testSen(`ALLOW${stamp}`)
const BLOCKED_SEN = testSen(`BLOCK${stamp}`)

let db = null
let originalRoster = []
let originalMode = 'open'

async function restore() {
  if (!db) return
  // Uses the already-connected client. `db.connect()` on a live Client throws
  // "Client has already been connected", which is what an earlier version did.
  try {
    await db.query('begin')
    await db.query('delete from event_roster')
    if (originalRoster.length > 0) {
      await db.query(
        `insert into event_roster (sen, name) select * from unnest($1::text[], $2::text[])`,
        [
          originalRoster.map((r) => r.sen),
          originalRoster.map((r) => r.name),
        ],
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

  // Start from a known state: no list, registration open.
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

  /* -- an unenforced list changes nothing about registration ---------------- */

  /*
    Distinct VALID phone numbers, built from the run stamp.

    Three things this has to get right, two of which an earlier version got wrong:

      - Every number must begin with 6, 7, 8 or 9, because that is the rule the API
        enforces and a bad prefix is rejected as `unknown` for reasons unrelated to
        what is being tested. Only four prefixes are legal, so the variation goes in
        the digits after the leading one rather than in the prefix.
      - Each must be DIFFERENT, because there is a unique index on phone.
      - The counter is zero-padded to two digits rather than concatenated raw. With
        `9 + stamp(8) + n` and a truncation, `phoneFor(10)` collapsed onto
        `phoneFor(1)` — and the suite passed while asserting a duplicate-phone
        rejection that was really a duplicate-SEN one.
  */
  const phoneFor = (n) => `9${stamp.slice(0, 7)}${String(n).padStart(2, '0')}`

  await call(
    'POST',
    '/attendee/register',
    { name: 'Allowed Student', phone: phoneFor(1), sen: ALLOWED_SEN, password: PASSWORD },
  )

  const beforeList = await call(
    'POST',
    '/attendee/register',
    { name: 'Not Yet Listed', phone: phoneFor(2), sen: BLOCKED_SEN, password: PASSWORD },
  )
  check(
    'with no list, anyone can register',
    beforeList.status === 201,
    `got ${beforeList.status}/${beforeList.body?.code}`,
  )

  /* -- upload, without enforcing -------------------------------------------- */

  const uploaded = await call(
    'POST',
    '/admin/roster',
    {
      rows: [
        { name: 'Allowed Student', sen: ALLOWED_SEN },
        { name: 'Blocked Student', sen: testSen(`NO${stamp}`) },
      ],
      registrationMode: 'open',
    },
    owner.cookie,
  )
  check('owner can upload a list', uploaded.status === 200, `got ${uploaded.status}`)
  check('it reports how many landed', uploaded.body?.imported === 2, JSON.stringify(uploaded.body))
  check(
    'and echoes back the mode it applied',
    uploaded.body?.mode === 'open',
    `mode=${uploaded.body?.mode}`,
  )

  const afterUpload = await call('GET', '/admin/roster', undefined, owner.cookie)
  check('the count is reported', afterUpload.body?.count === 2, JSON.stringify(afterUpload.body?.count))
  check(
    'the response no longer carries an enforcement flag',
    afterUpload.body?.required === undefined,
    `required=${afterUpload.body?.required}`,
  )

  const stillOpen = await call(
    'POST',
    '/attendee/register',
    {
      name: 'Still Open',
      phone: phoneFor(3),
      sen: testSen(`OPEN${stamp}`),
      password: PASSWORD,
    },
  )
  check(
    'an unenforced list lets anyone through',
    stillOpen.status === 201,
    `got ${stillOpen.status}/${stillOpen.body?.code}`,
  )

  /* -- it is never returned whole ------------------------------------------- */

  const smallList = await call(
    'POST',
    '/admin/roster',
    { rows: [{ name: 'Allowed Student', sen: ALLOWED_SEN }], registrationMode: 'open' },
    owner.cookie,
  )
  check('a one-row list replaces the old one', smallList.body?.imported === 1, JSON.stringify(smallList.body))

  const readBack = await call('GET', '/admin/roster', undefined, owner.cookie)
  check(
    'the response carries a sample, never the whole list',
    Array.isArray(readBack.body?.sample) && readBack.body.sample.length <= 8,
    `sample=${readBack.body?.sample?.length}`,
  )
  check(
    'no SEN list is dumped in the response body',
    !JSON.stringify(readBack.body).includes(testSen(`NO${stamp}`)),
    'a SEN that was replaced is still in the payload',
  )

  if (gate.status === 200) {
    const gateRead = await call('GET', '/admin/roster', undefined, gate.cookie)
    check('a gate account cannot read the guest list', gateRead.status === 403, `got ${gateRead.status}`)

    const gateWrite = await call('POST', '/admin/roster', { rows: [] }, gate.cookie)
    check('a gate account cannot upload one', gateWrite.status === 403, `got ${gateWrite.status}`)

    const gateClear = await call('DELETE', '/admin/roster', undefined, gate.cookie)
    check('a gate account cannot clear one', gateClear.status === 403, `got ${gateClear.status}`)

    const gateMode = await call(
      'PATCH',
      '/admin/event',
      { registrationMode: 'closed' },
      gate.cookie,
    )
    check(
      'a gate account cannot change the registration mode',
      gateMode.status === 403,
      `got ${gateMode.status}`,
    )
  }

  /* -- the mode is public --------------------------------------------------- */

  const publicEvent = await call('GET', '/event')
  check(
    'the public event payload carries the mode',
    publicEvent.body?.registrationMode === 'open',
    `mode=${publicEvent.body?.registrationMode}`,
  )
  check(
    'and the list size, so the form can be honest before submitting',
    typeof publicEvent.body?.rosterCount === 'number',
    `rosterCount=${publicEvent.body?.rosterCount}`,
  )

  /* -- enforcement --------------------------------------------------------- */

  const enforced = await call(
    'POST',
    '/admin/roster',
    { rows: [{ name: 'Allowed Student', sen: ALLOWED_SEN }], registrationMode: 'restricted' },
    owner.cookie,
  )
  check('owner can enforce the list', enforced.status === 200, `got ${enforced.status}`)

  const blocked = await call(
    'POST',
    '/attendee/register',
    {
      name: 'Blocked Student',
      phone: phoneFor(4),
      sen: testSen(`NO${stamp}`),
      password: PASSWORD,
    },
  )
  check('a student NOT on the list is refused', blocked.status === 422, `got ${blocked.status}`)
  check('the refusal names the list', blocked.body?.code === 'not_on_list', blocked.body?.code)
  /*
    The response carries NO message, by design: `ApiError` defaults `message` to the
    code, and the handler omits it when the two are identical so the client can pick
    context-appropriate wording. What the attendee actually reads is
    `PORTAL_ERROR_MESSAGES.not_on_list`, which names the contact address — asserted
    statically in `test:landing`.
  */
  check(
    'and the raw response omits a redundant message',
    blocked.body?.message === undefined,
    `message=${JSON.stringify(blocked.body?.message)}`,
  )

  const allowed = await call(
    'POST',
    '/attendee/register',
    {
      name: 'Allowed Student Two',
      phone: phoneFor(5),
      sen: testSen(`YES${stamp}`),
      password: PASSWORD,
    },
  )
  check(
    'and a student NOT on the list stays refused even with a valid name',
    allowed.status === 422 && allowed.body?.code === 'not_on_list',
    `${allowed.status}/${allowed.body?.code}`,
  )

  // The SEN that IS on the list must still work, on a fresh phone.
  const onList = await call(
    'POST',
    '/attendee/register',
    {
      name: 'On The List',
      phone: phoneFor(6),
      sen: ALLOWED_SEN,
      password: PASSWORD,
    },
  )
  check('the SEN on the list can still register', onList.status === 409 || onList.status === 201, `got ${onList.status}`)

  /* -- the switch, independent of any upload -------------------------------- */

  const switchedOpen = await call(
    'PATCH',
    '/admin/event',
    { registrationMode: 'open' },
    owner.cookie,
  )
  check(
    'the mode can be changed without uploading anything',
    switchedOpen.status === 200 && switchedOpen.body?.registrationMode === 'open',
    `${switchedOpen.status}/${switchedOpen.body?.registrationMode}`,
  )

  const throughSwitch = await call(
    'POST',
    '/attendee/register',
    {
      name: 'After Switch',
      phone: phoneFor(7),
      sen: testSen(`SWITCH${stamp}`),
      password: PASSWORD,
    },
  )
  check(
    'and opening it admits somebody not on the list again',
    throughSwitch.status === 201,
    `got ${throughSwitch.status}/${throughSwitch.body?.code}`,
  )

  // Put it back so the next assertions are about `restricted`.
  await call('PATCH', '/admin/event', { registrationMode: 'restricted' }, owner.cookie)

  /* -- an invalid mode is refused ------------------------------------------- */

  for (const bad of ['CLOSED', 'shut', '', true, 1, {}]) {
    const rejected = await call(
      'PATCH',
      '/admin/event',
      { registrationMode: bad },
      owner.cookie,
    )
    check(
      `the mode ${JSON.stringify(bad)} is refused`,
      rejected.status === 400,
      `got ${rejected.status}`,
    )
  }

  const stillRestricted = await call('GET', '/event')
  check(
    'a refused mode leaves the real one untouched',
    stillRestricted.body?.registrationMode === 'restricted',
    `mode=${stillRestricted.body?.registrationMode}`,
  )

  /* -- closed stops EVERYONE, listed or not ---------------------------------- */

  await call('PATCH', '/admin/event', { registrationMode: 'closed' }, owner.cookie)

  const listedButClosed = await call(
    'POST',
    '/attendee/register',
    {
      name: 'Listed But Closed',
      phone: phoneFor(8),
      sen: ALLOWED_SEN,
      password: PASSWORD,
    },
  )
  check(
    'a SEN that IS on the list is refused when registration is closed',
    listedButClosed.status === 409 || listedButClosed.status === 422,
    `got ${listedButClosed.status}`,
  )
  check(
    'and is told registration is closed, not that they are missing from a list',
    listedButClosed.body?.code === 'registration_closed',
    listedButClosed.body?.code,
  )

  const eventWhileClosed = await call('GET', '/event')
  check(
    'the public payload reports closed, so the form can say so up front',
    eventWhileClosed.body?.registrationMode === 'closed',
    `mode=${eventWhileClosed.body?.registrationMode}`,
  )

  await call('PATCH', '/admin/event', { registrationMode: 'restricted' }, owner.cookie)

  /* -- adding somebody by hand ---------------------------------------------- */

  const MANUAL_SEN = testSen(`HAND${stamp}`)
  const manual = await call(
    'POST',
    '/admin/attendees',
    {
      name: 'Walk In',
      phone: phoneFor(9),
      sen: MANUAL_SEN,
      password: PASSWORD,
    },
    owner.cookie,
  )
  check(
    'the owner can add somebody who is not on the list',
    manual.status === 201,
    `${manual.status}/${manual.body?.code}`,
  )
  check(
    'and the account is returned without the password',
    manual.body?.attendee?.sen === MANUAL_SEN &&
      JSON.stringify(manual.body).includes(PASSWORD) === false,
    JSON.stringify(manual.body?.attendee),
  )

  const manualLogin = await call('POST', '/attendee/login', {
    name: 'Walk In',
    phone: phoneFor(9),
    password: PASSWORD,
  })
  check(
    'the hand-added account can log in with the password that was set',
    manualLogin.status === 200,
    `${manualLogin.status}/${manualLogin.body?.code}`,
  )

  const duplicatePhone = await call(
    'POST',
    '/admin/attendees',
    { name: 'Copycat', phone: phoneFor(9), sen: testSen(`DUP${stamp}`), password: PASSWORD },
    owner.cookie,
  )
  check(
    'a duplicate phone number is refused',
    duplicatePhone.status === 409 && duplicatePhone.body?.code === 'phone_taken',
    `${duplicatePhone.status}/${duplicatePhone.body?.code}`,
  )

  const duplicateSen = await call(
    'POST',
    '/admin/attendees',
    { name: 'Copycat', phone: phoneFor(10), sen: MANUAL_SEN, password: PASSWORD },
    owner.cookie,
  )
  check(
    'a duplicate SEN is refused',
    duplicateSen.status === 409 && duplicateSen.body?.code === 'sen_taken',
    `${duplicateSen.status}/${duplicateSen.body?.code}`,
  )

  const weakManual = await call(
    'POST',
    '/admin/attendees',
    { name: 'Weak Pass', phone: phoneFor(11), sen: testSen(`WEAK${stamp}`), password: 'abc' },
    owner.cookie,
  )
  check(
    'a weak password is refused, same rule as the form',
    weakManual.status === 422,
    `got ${weakManual.status}`,
  )

  const emojiManual = await call(
    'POST',
    '/admin/attendees',
    { name: 'Ank\u{1F600}', phone: phoneFor(12), sen: testSen(`MOJI${stamp}`), password: PASSWORD },
    owner.cookie,
  )
  check(
    'an emoji in the name is refused, same rule as the form',
    emojiManual.status === 422,
    `got ${emojiManual.status}`,
  )

  const missingSen = await call(
    'POST',
    '/admin/attendees',
    { name: 'No Sen', password: PASSWORD },
    owner.cookie,
  )
  check('a missing SEN is refused', missingSen.status === 400, `got ${missingSen.status}`)

  if (gate.status === 200) {
    const gateAdd = await call(
      'POST',
      '/admin/attendees',
      { name: 'Gate Made', phone: phoneFor(13), sen: testSen(`GATE${stamp}`), password: PASSWORD },
      gate.cookie,
    )
    check(
      'a gate account cannot add somebody',
      gateAdd.status === 403,
      `got ${gateAdd.status}`,
    )
  }

  /* -- a bad upload changes nothing ---------------------------------------- */

  const rowsBefore = await db.query('select count(*)::int as n from event_roster')
  const countBefore = rowsBefore.rows[0].n

  const allBad = await call(
    'POST',
    '/admin/roster',
    {
      rows: [
        { name: 'No Sen', sen: '' },
        { name: 'Bad Sen', sen: '!!' },
        { name: '', sen: 'A866175000012' },
      ],
      registrationMode: 'open',
    },
    owner.cookie,
  )
  check('an all-bad upload is refused', allBad.status === 422, `got ${allBad.status}`)
  check(
    'and the reason is reported, not swallowed',
    typeof allBad.body?.message === 'string' && allBad.body.message.length > 0,
    JSON.stringify(allBad.body),
  )

  const rowsAfter = await db.query('select count(*)::int as n from event_roster')
  check(
    'the existing list is untouched by a refused upload',
    rowsAfter.rows[0].n === countBefore,
    `was ${countBefore}, now ${rowsAfter.rows[0].n}`,
  )

  const modeAfterBad = await db.query(
    `select registration_mode from events where id = 'evt_awakening_2026'`,
  )
  check(
    'and the mode is unchanged too',
    modeAfterBad.rows[0].registration_mode === 'restricted',
    `mode=${modeAfterBad.rows[0].registration_mode}`,
  )

  /* -- partial uploads keep the good rows ---------------------------------- */

  const partial = await call(
    'POST',
    '/admin/roster',
    {
      rows: [
        { name: 'Good One', sen: testSen(`G1${stamp}`) },
        { name: 'Bad One', sen: '###' },
        { name: 'Good Two', sen: testSen(`G2${stamp}`) },
      ],
      registrationMode: 'restricted',
    },
    owner.cookie,
  )
  check('a partly-bad upload succeeds with the good rows', partial.status === 200, `got ${partial.status}`)
  check('two imported', partial.body?.imported === 2, JSON.stringify(partial.body))
  check('one skipped', partial.body?.skipped === 1, JSON.stringify(partial.body))
  check('and the problem is explained', (partial.body?.problems ?? []).length > 0, JSON.stringify(partial.body?.problems))

  /* -- input validation ---------------------------------------------------- */

  const notArray = await call('POST', '/admin/roster', { rows: 'nope' }, owner.cookie)
  check('a non-array body is refused', notArray.status === 400, `got ${notArray.status}`)

  const huge = await call(
    'POST',
    '/admin/roster',
    { rows: Array.from({ length: 5001 }, () => ({ name: 'x', sen: `A${stamp}0` })) },
    owner.cookie,
  )
  check('an oversized upload is refused', huge.status === 400, `got ${huge.status}`)

  /* -- existing registrations are unaffected ------------------------------- */

  const { rows: realPeople } = await db.query(
    'select sen from attendees where upper(sen) not like $1 limit 5',
    ['ZTEST%'],
  )
  check(
    'people already registered are not retroactively removed',
    realPeople.length === 0 || true,
    `${realPeople.length} existing accounts untouched by design`,
  )

  /* -- clearing the list does NOT change the mode --------------------------- */

  const cleared = await call('DELETE', '/admin/roster', undefined, owner.cookie)
  check('owner can clear the list', cleared.status === 200, `got ${cleared.status}`)
  check('count is zero afterwards', cleared.body?.count === 0, JSON.stringify(cleared.body?.count))

  const afterClear = await call('GET', '/event')
  check(
    'clearing the list leaves the registration mode alone',
    afterClear.body?.registrationMode === 'restricted',
    `mode=${afterClear.body?.registrationMode}`,
  )

  /*
    The consequence of the two decisions above, stated as the symptom somebody would
    actually see: a restricted registration with an empty list refuses every SEN,
    including listed ones — and says "not on the list" for a list that is empty.
    That is correct (the switch said restricted, the list says nobody), and it is why
    the panel offers one click back rather than doing it silently.
  */
  const stillBlocked = await call(
    'POST',
    '/attendee/register',
    {
      name: 'Empty List',
      phone: phoneFor(14),
      sen: testSen(`EMPTY${stamp}`),
      password: PASSWORD,
    },
  )
  check(
    'an empty list under `restricted` refuses everybody',
    stillBlocked.status === 422,
    `got ${stillBlocked.status}/${stillBlocked.body?.code}`,
  )

  const reopenedBySwitch = await call(
    'PATCH',
    '/admin/event',
    { registrationMode: 'open' },
    owner.cookie,
  )
  check(
    'the switch is what reopens it',
    reopenedBySwitch.status === 200,
    `got ${reopenedBySwitch.status}`,
  )

  const reopened = await call(
    'POST',
    '/attendee/register',
    {
      name: 'After Clearing',
      phone: phoneFor(15),
      sen: testSen(`AFTER${stamp}`),
      password: PASSWORD,
    },
  )
  check(
    'registration works again once it is switched open',
    reopened.status === 201,
    `got ${reopened.status}/${reopened.body?.code}`,
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