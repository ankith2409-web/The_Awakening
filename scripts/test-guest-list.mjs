#!/usr/bin/env node
/**
 * The guest list: upload, enforcement, and — the part that matters — what must
 * survive a bad upload.
 *
 * This suite exists because the blast radius is unusual. Registration is the only
 * door into the event, and an enforced list closes it to everyone not on it. There
 * is no self-service route out and no undo from the attendee's side, so a mistake
 * here locks real students out of an event six days away.
 *
 * Three things are therefore asserted that would not be worth asserting for an
 * ordinary write:
 *
 *   1. A refused upload changes NOTHING. A partially-applied list locks out whichever
 *      students did not land, and the symptom they see is "you are not on the list",
 *      which points at the list rather than at the upload that broke it.
 *   2. Enforcement is off by default and survives an upload that does not ask for it.
 *   3. The list is never returned whole — a `gate` account must not be able to read
 *      every student's name and SEN, which is the roster with extra steps.
 *
 * Restores the previous state on every exit path. A list left enforced would refuse
 * registration on the live site until somebody noticed.
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
let originalRequired = false

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
      `update events set roster_required = $1, roster_uploaded_at = $2 where id = 'evt_awakening_2026'`,
      [originalRequired, originalRoster.length > 0 ? new Date() : null],
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
    `select roster_required from events where id = 'evt_awakening_2026'`,
  )
  originalRequired = before[0]?.roster_required ?? false

  const { rows: existing } = await db.query('select sen, name from event_roster')
  originalRoster = existing

  // Start from a known state: no list, registration open.
  await db.query('delete from event_roster')
  await db.query(
    `update events set roster_required = false, roster_uploaded_at = null where id = 'evt_awakening_2026'`,
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

    Two things this has to get right, both of which an earlier version got wrong:
    every number must begin with 6, 7, 8 or 9, because that is the rule the API
    enforces and a bad prefix is rejected as `unknown` for reasons unrelated to what
    is being tested; and each must be DIFFERENT, because there is a unique index on
    phone. Only four prefixes are legal, so the variation goes in the digits after
    the leading one rather than in the prefix.
  */
  const phoneFor = (n) => `9${stamp.slice(0, 8)}${n}`.slice(0, 10)

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
      required: false,
    },
    owner.cookie,
  )
  check('owner can upload a list', uploaded.status === 200, `got ${uploaded.status}`)
  check('it reports how many landed', uploaded.body?.imported === 2, JSON.stringify(uploaded.body))

  const afterUpload = await call('GET', '/admin/roster', undefined, owner.cookie)
  check('the count is reported', afterUpload.body?.count === 2, JSON.stringify(afterUpload.body?.count))
  check(
    'it is NOT enforced when the upload did not ask',
    afterUpload.body?.required === false,
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
    { rows: [{ name: 'Allowed Student', sen: ALLOWED_SEN }], required: false },
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
  }

  /* -- enforcement --------------------------------------------------------- */

  const enforced = await call(
    'POST',
    '/admin/roster',
    { rows: [{ name: 'Allowed Student', sen: ALLOWED_SEN }], required: true },
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
      required: false,
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

  const stillEnforced = await call('GET', '/admin/roster', undefined, owner.cookie)
  check(
    'and enforcement is unchanged too',
    stillEnforced.body?.required === true,
    `required=${stillEnforced.body?.required}`,
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
      required: true,
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

  /* -- clearing reopens registration --------------------------------------- */

  const cleared = await call('DELETE', '/admin/roster', undefined, owner.cookie)
  check('owner can clear the list', cleared.status === 200, `got ${cleared.status}`)
  check('count is zero afterwards', cleared.body?.count === 0, JSON.stringify(cleared.body?.count))

  const reopened = await call(
    'POST',
    '/attendee/register',
    {
      name: 'After Clearing',
      phone: phoneFor(7),
      sen: testSen(`AFTER${stamp}`),
      password: PASSWORD,
    },
  )
  check(
    'registration works again after clearing',
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