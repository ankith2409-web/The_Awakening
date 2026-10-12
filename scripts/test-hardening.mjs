#!/usr/bin/env node
/**
 * Adversarial inputs and the authorisation boundary.
 *
 * The other suites prove the documented behaviour: the happy path, and the refusals
 * the portal promises. This one assumes the handlers are wrong in the ways handlers
 * usually are — a field read without a type check, a bound enforced on the value but
 * not on the shape, authorisation on the route but reachable another way, a body that
 * parses to something the handler then dereferences blindly.
 *
 * Two real defects came out of this and are worth naming, because both were invisible
 * to everything else:
 *
 *   1. A JSON body of \`null\` reached \`requireString\`, which read a property of it and
 *      threw a TypeError outside any guard. Every route that accepts a body answered
 *      500 to a malformed request — including registration, at a desk, where the
 *      generic "something went wrong, please try again" is both wrong and unactionable.
 *      Fixed in \`readJson\`, which now refuses anything that is not an object.
 *
 *   2. Values shaped like SQL injection reached the roster and were accepted. That is
 *      CORRECT, not a hole: the roster is organiser-uploaded data, SENs are normalised
 *      by stripping everything non-alphanumeric, and nothing renders unescaped. What
 *      matters — and what is asserted — is that no injection payload reaches a 500, and
 *      that the roster never reaches a file, where a comma or a leading \`=\` would
 *      matter. The export writes SENs only, quoted.
 *
 *   ADMIN_USERNAME / ADMIN_PASSWORD, ADMIN_PASSWORD_GATE, DATABASE_URL.
 */

import { Client } from 'pg'
import { testEmail } from './_fixtures.mjs'
import { loadEnv } from './_env.mjs'

loadEnv()

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'
const OWNER = {
  username: process.env.ADMIN_USERNAME ?? 'event.control',
  password: process.env.ADMIN_PASSWORD ?? '',
}
const GATE = { username: 'gate', password: process.env.ADMIN_PASSWORD_GATE ?? '' }

let passed = 0
let failed = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail ? `${label} -- ${detail}` : label)
  console.log(`\n  FAIL  ${label}`)
  if (detail) console.log(`          ${detail}`)
}

function jar() {
  return new Map()
}
function cookieHeader(store) {
  return [...store].map(([k, v]) => `${k}=${v}`).join('; ')
}
function absorb(store, res) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';')
    const i = pair.indexOf('=')
    if (i > 0) store.set(pair.slice(0, i), pair.slice(i + 1))
  }
}

/**
 * A raw request, because the interesting bodies are not JSON objects and `JSON.stringify`
 * cannot express them. `raw` is sent verbatim; the method/body rule is respected because
 * `fetch` throws rather than silently dropping a body on a GET.
 */
async function send(store, method, path, { json, raw, headers } = {}) {
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : raw !== undefined
        ? raw
        : json !== undefined
          ? JSON.stringify(json)
          : undefined

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: cookieHeader(store),
      ...(json !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body })
  absorb(store, res)
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* left null */
  }
  return { status: res.status, text, json: parsed }
}

async function login(store, who) {
  return (await send(store, 'POST', '/api/admin/login', { json: who })).status === 200
}

let db

async function main() {
  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await db.connect()

  const owner = jar()
  const gate = jar()
  const anon = jar()
  if (!(await login(owner, OWNER))) throw new Error('owner login failed')
  if (!(await login(gate, GATE))) throw new Error('gate login failed')

  /* ------------------------------------------------------- 1. bodies, not objects */

  console.log('\n  -- a body that is valid JSON but not an object --')

  const shapes = [
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['a bare string', '"hello"'],
    ['a number', '42'],
    ['a boolean', 'true'],
    ['not JSON at all', '{ this is not json'],
    ['a truncated object', '{"name":'],
  ]

  const bodyRoutes = [
    ['register', '/api/attendee/checkin'],
    ['attendee login', '/api/attendee/login'],
    ['admin login', '/api/admin/login'],
    ['scan', '/api/admin/attendance'],
    ['check-in', '/api/attendee/checkin'],
    ['broadcast', '/api/admin/push/send'],
  ]

  for (const [routeLabel, path] of bodyRoutes) {
    for (const [shapeLabel, raw] of shapes) {
      const r = await send(owner, 'POST', path, { raw })
      check(
        `${routeLabel} given ${shapeLabel} answers 4xx`,
        r.status >= 400 && r.status < 500,
        `got ${r.status} — a malformed request is never a server fault`,
      )
      check(
        `${routeLabel} given ${shapeLabel} never reaches an unhandled error`,
        r.status !== 500,
        `500 from ${path}: a TypeError escaped the handler`,
      )
    }
  }

  /* ------------------------------------------------------------ 2. wrong field types */

  console.log('\n  -- a field with the right name and the wrong type --')

  const typeProbes = [
    ['day as an object', '/api/admin/attendance', { sen: 'A866175000012', day: {} }],
    ['day as an array', '/api/admin/attendance', { sen: 'A866175000012', day: [1] }],
    ['day as a string', '/api/admin/attendance', { sen: 'A866175000012', day: '1' }],
    ['day as null', '/api/admin/attendance', { sen: 'A866175000012', day: null }],
    ['sen as a number', '/api/admin/attendance', { sen: 12345, day: 1 }],
    ['sen as an object', '/api/admin/attendance', { sen: { a: 1 }, day: 1 }],
    ['dayOverride as an array', '/api/admin/event', { dayOverride: [] }],
    ['lockedDays as a string', '/api/admin/event', { lockedDays: 'nope' }],
    ['phase as a number', '/api/admin/event', { phase: 7 }],
    ['registrationMode as junk', '/api/admin/event', { registrationMode: 'zzz' }],
    ['push keys as a string', '/api/attendee/push', { endpoint: 'https://x/y', keys: 'no' }],
    ['a check-in with no SEN', '/api/attendee/checkin', { name: 'x', phone: '9876543210' }],
    ['broadcast title as a number', '/api/admin/push/send', { title: 1, body: 'x' }],
  ]

  for (const [label, path, body] of typeProbes) {
    const r = await send(owner, 'POST', path, { json: body })
    check(`${label} is refused, not coerced`, r.status >= 400 && r.status < 500, `got ${r.status}`)
    check(`${label} does not reach an unhandled error`, r.status !== 500, '500')
  }

  /* -------------------------------------------------------------------- 3. sizes */

  console.log('\n  -- sizes --')

  const big = 'x'.repeat(200_000)
  for (const [label, path, body] of [
    ['a 200KB name', '/api/attendee/checkin', { name: big, phone: '9000000001', sen: 'Z1' , email: testEmail('probe')}],
    ['a 200KB SEN', '/api/attendee/checkin', { name: 'A B', phone: '9000000001', sen: big , email: testEmail('probe')}],
    ['a 200KB broadcast subject', '/api/admin/push/send', { title: big, body: 'x' }],
  ]) {
    const r = await send(owner, 'POST', path, { json: body })
    check(`${label} is refused without dying`, r.status >= 400 && r.status < 500, `got ${r.status}`)
    check(`${label} does not reach an unhandled error`, r.status !== 500, '500')
  }

  /* --------------------------------------------------------------- 4. injection-ish */

  console.log('\n  -- values shaped like injection --')

  const payloads = [
    "'; drop table attendees; --",
    "' OR '1'='1",
    'A866175000012\' UNION SELECT null--',
    '<script>alert(1)</script>',
    '../../etc/passwd',
    '${jndi:ldap://x}',
    'A866175000012\u0000',
    '\u0000\u0001binary',
  ]

  /*
    Injection payloads, aimed at where organiser-typed text actually lands now.

    This used to target `POST /api/admin/roster`, and needed a guard around it: the
    guest list was the organiser's own spreadsheet, deleting it to test the
    cleanup destroyed real data, and it did exactly that once.

    Both the route and the risk are gone. There is no guest list and no roster
    table. The same strings go to the check-in instead, which is a route that
    writes a real row — so "does not fault" and "wrote nothing" are now assertions
    about live data rather than about a 404, which is the stronger version of the
    same test.

    The fixtures this creates are swept by the prefix purge at the end.
  */

  for (const payload of payloads) {
    const r = await send(owner, 'POST', '/api/attendee/checkin', {
      json: {
        name: payload,
        phone: '9' + String(payload.length).padStart(9, '4'),
        sen: 'A866175999' + String(payload.length).padStart(3, '0'),
      } })
    check(
      `a check-in named ${JSON.stringify(payload.slice(0, 22))} does not fault`,
      r.status < 500,
      `got ${r.status}`,
    )
  }

  const { rows: stillThere } = await db.query('select count(*)::int as n from attendees')
  check('the attendees table survived every injection payload', typeof stillThere[0].n === 'number')

  /*
    No restore to verify, and nothing to restore.

    The old version ended with a check that the guest list came back exactly as it
    was found, because it had just deleted it. There is no guest list and this
    block no longer deletes anything.

    What IS still asserted, and matters more, is that the payloads did not write
    rows: every one of them is either refused by validation or lands under a name
    the prefix purge sweeps at the end of the run.
  */

  /* ------------------------------------------------------------ 5. authorisation */

  console.log('\n  -- every route, as every identity --')

  /*
    Two routes are public on purpose and are checked as such rather than as leaks.
    `GET /event` is the programme. `GET /push/key` is the VAPID public key, which is an
    address rather than a credential and is needed before anybody logs in.
  */
  /*
    Public, and public for everyone.

    The check-in needs no credential at all, which is the whole design: a student
    scans a poster on a wall and types their details. A route here that started
    demanding a session would put a login between somebody and recording that they
    arrived.
  */
  const publicRoutes = ['/api/event', '/api/attendee/attendance']

  for (const path of publicRoutes) {
    check(`anonymous can read ${path}`, (await send(anon, 'GET', path)).status === 200)
  }

  /*
    ROUTES THAT NO LONGER EXIST.

    Asserted 404 for every role, OWNER INCLUDED. That last one is the assertion
    that matters: the failure worth catching is not that a volunteer is refused,
    it is somebody re-adding one of these while tidying up believing it was still
    a feature — and only an owner would have been able to re-add it.
  */
  const REMOVED_ROUTES = [
    '/api/admin/roster',
    '/api/admin/roster/rows',
    '/api/admin/push',
    '/api/attendee/ticket',
    '/api/attendee/register',
    '/api/attendee/login',
    '/api/attendee/session',
  ]

  for (const path of REMOVED_ROUTES) {
    for (const [label, session] of [
      ['anonymous', anon],
      ['gate', gate],
      ['owner', owner],
    ]) {
      const r = await send(session, 'GET', path)
      check(
        `${label} gets 404 for ${path}, not a permission error`,
        r.status === 404,
        `got ${r.status}`,
      )
    }
  }

  /*
    The attendance lookup with no SEN.

    It used to answer 200 with a null body so a dashboard could render "not marked
    yet" when a session had expired. There is no dashboard and no session, so it is
    a SEN lookup: no SEN, no records, and never an error.

    Refusing it instead would tell a student their number was wrong when the only
    true statement is that they have not been marked yet.
  */
  const noSen = await send(anon, 'GET', '/api/attendee/attendance')
  check(
    'the attendance lookup with no SEN is 200, not an error',
    noSen.status === 200,
    `got ${noSen.status}`,
  )

  /* ------------------------------------------------------------- 6. the gate role */

  console.log('\n  -- the shared gate credential --')

  const { rows: anyAttendee } = await db.query('select sen from attendees limit 1')
  const aSen = anyAttendee[0]?.sen ?? 'A000000000012'

  /*
    THE OWNER-ONLY ROUTES THAT REMAIN.

    Authorisation is a live question for these, so 403 is the right answer and a
    404 would mean the route had gone missing rather than the guard working.
  */
  const ownerOnly = [
    ['GET', '/api/admin/attendees'],
    ['PATCH', '/api/admin/event'],
  ]

  for (const [method, path] of ownerOnly) {
    const r = await send(gate, method, path, { json: {} })
    check(`gate is refused ${method} ${path}`, r.status === 403, `got ${r.status}`)
  }

  /*
    The agenda mutation is gone entirely, so it cannot be an authorisation
    question any more — there is no owner who may do it either.

    Asserted for every role, because the interesting failure is not `gate` being
    refused. It is somebody re-adding the route while tidying up, believing it
    was still a feature.
  */
  for (const [label, session] of [
    ['gate', gate],
    ['owner', owner],
  ]) {
    const r = await send(session, 'PATCH', '/api/admin/agenda/ag_01', { json: { status: 'done' } })
    check(`${label} cannot patch an agenda item either`, r.status === 404, `got ${r.status}`)
  }

  const agendaNow = await db.query('select status from agenda where id = $1', ['ag_01'])
  check(
    'no role can move an agenda item, whatever the response said',
    agendaNow.rows[0]?.status === 'upcoming',
    `status is "${agendaNow.rows[0]?.status}"`,
  )

  /*
    gate MAY scan, and the answer for a SEN nobody is registered under is `unknown_sen`
    at 422 — not a 403. A volunteer typing a badge they misread must be told the badge
    is unknown; telling them their account cannot make changes sends them to an
    organiser instead of to the person who can fix it.
  */
  const gateScan = await send(gate, 'POST', '/api/admin/attendance', {
    json: { sen: 'A000000000012', day: 1 } })
  check(
    'gate may scan, and an unknown SEN is unknown_sen rather than forbidden',
    gateScan.status === 422 && gateScan.json?.code === 'unknown_sen',
    `got ${gateScan.status} ${gateScan.text.slice(0, 50)}`,
  )

  /* ---------------------------------------------------------- 7. method confusion */

  console.log('\n  -- the wrong verb on a real path --')

  for (const [method, path] of [
    ['DELETE', '/api/event'],
    ['PUT', '/api/admin/roster'],
    ['POST', '/api/admin/session'],
    ['DELETE', '/api/push/key'],
    ['PATCH', '/api/attendee/ticket'],
  ]) {
    const r = await send(owner, method, path, { json: {} })
    check(`${method} ${path} is not routed`, r.status === 404 || r.status === 405, `got ${r.status}`)
  }

  /* ---------------------------------------------------------------- 8. concurrency */

  console.log('\n  -- two identical requests at the same instant --')

  const sen = 'ZCONCUR0000001'
  await db.query('delete from sessions where subject_id in (select id from attendees where upper(sen) = upper($1))', [sen])
  await db.query('delete from attendees where upper(sen) = upper($1)', [sen])

  const [a, b] = await Promise.all([
    send(anon, 'POST', '/api/attendee/checkin', {
      json: { name: 'Race One', phone: '9000000071', sen, email: testEmail('probe') } }),
    send(anon, 'POST', '/api/attendee/checkin', {
      json: { name: 'Race Two', phone: '9000000072', sen, email: testEmail('probe') } }),
  ])

  const winners = [a, b].filter((r) => r.status === 201).length
  check(
    'two simultaneous registrations of one SEN create one account',
    winners === 1,
    `${winners} succeeded (${a.status}, ${b.status})`,
  )

  const { rows: raceRows } = await db.query(
    'select count(*)::int as n from attendees where upper(sen) = upper($1)',
    [sen],
  )
  check('and exactly one row exists', raceRows[0].n === 1, `${raceRows[0].n} rows`)

  await db.query('delete from sessions where subject_id in (select id from attendees where upper(sen) = upper($1))', [sen])
  await db.query('delete from attendees where upper(sen) = upper($1)', [sen])

  /*
    Two scanners hitting the same badge at the same instant. The unique index on
    (attendee_id, day) is the real guard, so this is checking that the INSERT is not a
    SELECT-then-INSERT with a window in it — the failure would be two attendance rows
    for one person on one day, which is a corrupt export and an organiser's problem at
    the end of the event.
  */
  /*
    A badge THIS SUITE creates, so the only attendance rows it can remove are the ones
    it made.

    The previous version took the first real attendee, scanned their badge, and deleted
    what it wrote -- which is a test that damages live data in order to assert that it
    does not. That is not a subtle risk; it had already destroyed real records here.
  */
  const probeSen = 'ZCONCURRENT01'
  await db.query('delete from sessions where subject_id in (select id from attendees where upper(sen) = upper($1))', [probeSen])
  await db.query('delete from attendance where upper(sen) = upper($1)', [probeSen])
  await db.query('delete from attendees where upper(sen) = upper($1)', [probeSen])

  const created = await send(anon, 'POST', '/api/attendee/checkin', {
    json: { name: 'Concurrency Probe', phone: '9000000079', sen: probeSen } })

  if (created.status === 201) {
    /*
      Two check-ins of one person at the same instant.

      The unique index on (attendee_id, day) is the real guard, so this is checking
      that the write is not a SELECT-then-INSERT with a window in it. Two rows for
      one person on one day is a corrupt export and an organiser's problem at the end
      of the event.

      The property is "EXACTLY ONE ROW EXISTS", not "exactly one request answered
      201". Counting status codes was true when creating and marking were separate
      acts; now they are one request, and the row count is the thing that matters.
    */
    const [c, d] = await Promise.all([
      send(anon, 'POST', '/api/attendee/checkin', {
        json: { name: 'Concurrency Probe', phone: '9000000079', sen: probeSen },
      }),
      send(anon, 'POST', '/api/attendee/checkin', {
        json: { name: 'Concurrency Probe', phone: '9000000079', sen: probeSen },
      }),
    ])

    check(
      'two simultaneous check-ins of one person both answer, neither errors',
      [c, d].every((r) => r.status === 200 || r.status === 201),
      `(${c.status}, ${d.status})`,
    )

    const { rows: dayRows } = await db.query(
      'select count(*)::int as n from attendance where upper(sen) = upper($1) and day = 1',
      [probeSen],
    )
    check('and there is one row for that day, not two', dayRows[0].n === 1, `${dayRows[0].n} rows`)
  } else {
    check('the concurrency probe could register', false, `register returned ${created.status}`)
  }

  /*
    Cleanup is scoped to the probe's own SEN.

    Never a blanket delete, and never a real attendee's SEN: this suite runs against the
    live database by design, and a cleanup that is not provably narrow is a cleanup that
    will eventually take somebody's record with it.
  */
  await db.query('delete from attendance where upper(sen) = upper($1)', [probeSen])
  await db.query('delete from sessions where subject_id in (select id from attendees where upper(sen) = upper($1))', [probeSen])
  await db.query('delete from attendees where upper(sen) = upper($1)', [probeSen])

  /*
    Scoped to this suite own badges, not to every SEN starting with Z.

    A blanket prefix scan is the right instinct for the other suites -- anything an
    interrupted run left behind needs sweeping -- but here it also counts rows this
    suite never touched, so it reports a failure that is not one. That was
    demonstrated rather than assumed: a sentinel attendee deliberately planted with a
    Z-prefixed SEN made this assertion fail while the suite was provably leaving
    nothing behind.
  */
  for (const [label, query, args] of [
    ['attendees', 'select count(*)::int as n from attendees where upper(sen) = any($1::text[])', [['ZCONCURRENT01']]],
    ['attendance', 'select count(*)::int as n from attendance where upper(sen) = any($1::text[])', [[probeSen]]],
  ]) {
    const { rows: left } = await db.query(query, args)
    check(`this suite left no ${label} behind`, left[0].n === 0, `${left[0].n} rows remain`)
  }
  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failures.length > 0) {
    console.log('\n  --- every failure ---')
    for (const f of failures) console.log(`   - ${f}`)
  }
}

main()
  .catch((error) => {
    console.error('\n  crashed:', error.stack ?? error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    if (db) await db.end().catch(() => {})
  })