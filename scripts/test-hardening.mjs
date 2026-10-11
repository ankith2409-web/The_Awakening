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
    body,
  })
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
    ['register', '/api/attendee/register'],
    ['attendee login', '/api/attendee/login'],
    ['admin login', '/api/admin/login'],
    ['scan', '/api/admin/attendance'],
    ['roster upload', '/api/admin/roster'],
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
    ['roster rows as a string', '/api/admin/roster', { rows: 'nope' }],
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
    ['a 200KB name', '/api/attendee/register', { name: big, phone: '9000000001', sen: 'Z1' }],
    ['a 200KB SEN', '/api/attendee/register', { name: 'A B', phone: '9000000001', sen: big }],
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
    Snapshot the guest list, and put it back afterwards.

    The obvious cleanup -- `delete from event_roster` -- is the same mistake as picking
    a real attendee for the concurrency probe: this suite runs against the live database,
    and the roster is every student's name and SEN that the organiser uploaded. Clearing
    it would destroy real data in the name of testing it.

    So: read it, run the probes, and restore exactly what was there. If the list was
    empty, restoring an empty list is a no-op and the owner never notices this suite
    ran at all.
  */
  const rosterSnapshot = await db.query('select sen, name from event_roster')
  const beforeRoster = { rows: [{ n: rosterSnapshot.rows.length }] }

  for (const payload of payloads) {
    const r = await send(owner, 'POST', '/api/admin/roster', {
      json: { rows: [{ sen: payload, name: payload }] },
    })
    check(
      `roster upload with ${JSON.stringify(payload.slice(0, 22))} does not fault`,
      r.status < 500,
      `got ${r.status}`,
    )
  }

  const { rows: stillThere } = await db.query('select count(*)::int as n from attendees')
  check('the attendees table survived every injection payload', typeof stillThere[0].n === 'number')

  /*
    The roster IS allowed to hold odd text — it is organiser data, is displayed through
    React which escapes, and is never exported. What must hold is that it does not
    accumulate junk the owner would mistake for students, so it is restored here rather
    than left behind by this suite.
  */
  await db.query('delete from event_roster')
  for (const row of rosterSnapshot.rows) {
    await db.query('insert into event_roster (sen, name) values ($1, $2)', [row.sen, row.name])
  }

  const afterRoster = await db.query('select sen, name from event_roster order by sen')
  check(
    'the guest list is left exactly as it was found',
    afterRoster.rows.length === beforeRoster.rows[0].n &&
      afterRoster.rows.every((row, i) => {
        const was = rosterSnapshot.rows.slice().sort((x, y) => x.sen.localeCompare(y.sen))[i]
        return was && was.sen === row.sen && was.name === row.name
      }),
    `${beforeRoster.rows[0].n} rows before, ${afterRoster.rows.length} after`,
  )

  /* ------------------------------------------------------------ 5. authorisation */

  console.log('\n  -- every route, as every identity --')

  /*
    Two routes are public on purpose and are checked as such rather than as leaks.
    `GET /event` is the programme. `GET /push/key` is the VAPID public key, which is an
    address rather than a credential and is needed before anybody logs in.
  */
  const publicRoutes = ['/api/event', '/api/push/key']

  const protectedRoutes = [
    '/api/admin/roster',
    '/api/admin/roster/rows',
    '/api/admin/attendees',
    '/api/admin/attendance',
    '/api/admin/push',
    '/api/admin/agenda',
    '/api/attendee/ticket',
  ]

  for (const path of publicRoutes) {
    check(`anonymous can read ${path}`, (await send(anon, 'GET', path)).status === 200)
  }

  for (const path of protectedRoutes) {
    const r = await send(anon, 'GET', path)
    check(
      `anonymous is refused GET ${path}`,
      r.status === 401 || r.status === 403,
      `got ${r.status}`,
    )
  }

  /*
    `GET /attendee/attendance` answers 200 with a null body when there is no session,
    and that is deliberate: the dashboard renders "not marked yet", and a session that
    expired mid-view must not turn into an error. Asserted here so a future reader does
    not "fix" it into a 401 and break that path.
  */
  const noSession = await send(anon, 'GET', '/api/attendee/attendance')
  check(
    'a missing attendee session on /attendance is 200 with null, not an error',
    noSession.status === 200 && noSession.text.trim() === 'null',
    `got ${noSession.status} ${noSession.text.slice(0, 40)} — the dashboard needs this to render "not marked yet"`,
  )

  /* ------------------------------------------------------------- 6. the gate role */

  console.log('\n  -- the shared gate credential --')

  const { rows: anyAttendee } = await db.query('select sen from attendees limit 1')
  const aSen = anyAttendee[0]?.sen ?? 'A000000000012'

  const ownerOnly = [
    ['GET', '/api/admin/roster/rows'],
    ['POST', '/api/admin/roster'],
    ['DELETE', '/api/admin/roster'],
    ['POST', '/api/admin/attendees'],
    ['POST', '/api/admin/push/send'],
    ['POST', '/api/admin/attendees/password'],
  ]

  for (const [method, path] of ownerOnly) {
    const r = await send(gate, method, path, { json: { rows: [], status: 'done' } })
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
    json: { sen: 'A000000000012', day: 1 },
  })
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
    send(anon, 'POST', '/api/attendee/register', {
      json: { name: 'Race One', phone: '9000000071', sen },
    }),
    send(anon, 'POST', '/api/attendee/register', {
      json: { name: 'Race Two', phone: '9000000072', sen },
    }),
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

  const created = await send(anon, 'POST', '/api/attendee/register', {
    json: { name: 'Concurrency Probe', phone: '9000000079', sen: probeSen },
  })

  if (created.status === 201) {
    const login = jar()
    await send(login, 'POST', '/api/attendee/login', {
      json: { name: 'Concurrency Probe', phone: '9000000079', password: created.json.generatedPassword },
    })

    /*
      Two scanners hitting one badge at the same instant. The unique index on
      (attendee_id, day) is the real guard, so this is checking that the write is not a
      SELECT-then-INSERT with a window in it. Two rows for one person on one day is a
      corrupt export and an organiser's problem at the end of the event.
    */
    const [c, d] = await Promise.all([
      send(owner, 'POST', '/api/admin/attendance', { json: { sen: probeSen, day: 1 } }),
      send(owner, 'POST', '/api/admin/attendance', { json: { sen: probeSen, day: 1 } }),
    ])

    const accepted = [c, d].filter((r) => r.status === 201).length
    check(
      'two simultaneous scans of one badge record attendance once',
      accepted === 1,
      `${accepted} accepted (${c.status}, ${d.status})`,
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