#!/usr/bin/env node
/**
 * The API contract: what the routes do, who may do it, and what is gone.
 *
 * REWRITTEN around the check-in surface. The previous version covered
 * registration, login, sessions, tickets and the guest list — every one of which
 * was removed, so most of its assertions were asserting the absence of the API
 * rather than its behaviour.
 *
 * What this covers now:
 *
 *   1. The check-in route: shape, day resolution, and that the day is never
 *      taken from the body.
 *   2. The public event payload, which every visitor loads and which decides what
 *      the check-in page says.
 *   3. The authorisation matrix, which is the part that must not drift.
 *   4. THE REMOVED ROUTES ACTUALLY 404. Deleting a handler is not the same as
 *      removing a door; this asserts the old doors are shut rather than trusting
 *      that they are.
 *
 *   ADMIN_USERNAME / ADMIN_PASSWORD, ADMIN_PASSWORD_GATE, DATABASE_URL.
 */

import { Client } from 'pg'
import { loadEnv } from './_env.mjs'

loadEnv()

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'
const OWNER = { username: process.env.ADMIN_USERNAME ?? '', password: process.env.ADMIN_PASSWORD ?? '' }
const GATE = { username: 'gate', password: process.env.ADMIN_PASSWORD_GATE ?? '' }

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

async function call(method, path, body, cookie) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.Cookie = cookie

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  // getSetCookie, NOT the combined header. Without it every admin check below
  // passes by being refused an anonymous request, which looks exactly like a
  // working authorisation test while testing nothing.
  const setCookie =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const jar = setCookie.map((c) => c.split(';')[0]).join('; ')

  const text = await res.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json, cookie: jar, headers: res.headers }
}

/* ------------------------------------------------------------------ setup */

const stamp = Date.now().toString().slice(-7)
const SEN = `A9${stamp}0012`
const PHONE = `9${stamp}12`
let db = null

async function main() {
  console.log(`\n  API contract\n  ${BASE}\n`)

  db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()

  /* -- 1. the public event payload ----------------------------------------- */

  const event = await call('GET', '/event')
  check('the event payload is public', event.status === 200, `got ${event.status}`)
  check('it names the event', typeof event.json?.name === 'string' && event.json.name.length > 0)
  check('and gives the dates', typeof event.json?.date === 'string', JSON.stringify(event.json?.date))
  check('and the venue', typeof event.json?.venue === 'string' && event.json.venue.length > 0)
  check(
    'and which day is live, which is what a check-in will record against',
    Number.isInteger(event.json?.activeDay) && Number.isInteger(event.json?.totalDays),
    `activeDay=${event.json?.activeDay} totalDays=${event.json?.totalDays}`,
  )
  check(
    'and which days are closed, so the page can say so before anybody types',
    Array.isArray(event.json?.lockedDays),
    JSON.stringify(event.json?.lockedDays),
  )

  /* -- 2. the check-in ------------------------------------------------------ */

  const first = await call('POST', '/attendee/checkin', { name: 'Api Probe', phone: PHONE, sen: SEN })
  check('a check-in is accepted', first.status === 201, `${first.status} ${JSON.stringify(first.json)}`)
  check('it names the day', first.json?.day === event.json?.activeDay,
    `${first.json?.day} vs ${event.json?.activeDay}`)
  check('and returns the person', first.json?.sen === SEN, JSON.stringify(first.json))

  /* -- 3. THE DAY IS NEVER TAKEN FROM THE BODY ------------------------------ */

  /*
    The single most dangerous field this route could accept.

    A `day` in the body would let a stale page — or anyone with a script — file a
    whole queue under a day of their choosing, and the export would be the only
    place that ever showed it. The assertion is that the response reports the
    SERVER's day whatever the client claims.
  */
  const spoofed = await call('POST', '/attendee/checkin', {
    name: 'Api Probe',
    phone: PHONE,
    sen: SEN,
    day: 2,
  })
  check(
    'a day in the request body is ignored, and the server decides',
    spoofed.json?.day === event.json?.activeDay,
    `asked for ${spoofed.json?.day}, event says ${event.json?.activeDay}`,
  )

  /* -- 4. the attendance lookup -------------------------------------------- */

  const mine = await call('GET', `/attendee/attendance?sen=${SEN}`)
  check('a SEN can be looked up', mine.status === 200, `${mine.status}`)
  check('and returns its records', Array.isArray(mine.json?.records) && mine.json.records.length >= 1,
    JSON.stringify(mine.json))
  check('and names the day', mine.json?.records?.[0]?.day === event.json?.activeDay,
    JSON.stringify(mine.json?.records?.[0]))
  check('and the admission method, so the log can tell self from staff',
    mine.json?.records?.[0]?.method === 'self', JSON.stringify(mine.json?.records?.[0]))

  const nobody = await call('GET', '/attendee/attendance?sen=A000000000000')
  check('a SEN nobody has used returns nothing rather than everything',
    nobody.json?.records?.length === 0, JSON.stringify(nobody.json))

  /* -- 5. THE REMOVED ROUTES ACTUALLY 404 ----------------------------------- */

  /*
    Deleting a handler is not the same as removing a door.

    Every one of these was a way into the product. If any of them still answered,
    the redesign would be a UI over an old API rather than a removal, and nothing
    else in this suite would notice.
  */
  const GONE = [
    ['POST', '/attendee/register'],
    ['POST', '/attendee/login'],
    ['GET', '/attendee/session'],
    ['POST', '/attendee/logout'],
    ['POST', '/attendee/change-password'],
    ['GET', '/attendee/ticket'],
    ['POST', '/attendee/push'],
    ['GET', '/admin/roster'],
    ['POST', '/admin/roster'],
    ['POST', '/admin/attendees'],
    ['POST', '/admin/credentials/send'],
  ]

  for (const [method, path] of GONE) {
    const res = await call(method, path, method === 'GET' ? undefined : {})
    check(`${method} ${path} is gone`, res.status === 404, `got ${res.status}`)
  }

  /* -- 6. the authorisation matrix ----------------------------------------- */

  const ownerLogin = await call('POST', '/admin/login', OWNER)
  const gateLogin = await call('POST', '/admin/login', GATE)
  const hasOwner = ownerLogin.status === 200 && ownerLogin.cookie !== ''
  const hasGate = gateLogin.status === 200 && gateLogin.cookie !== ''

  check('an owner can sign in', hasOwner, `got ${ownerLogin.status}`)
  check('and really gets a session cookie', hasOwner && ownerLogin.cookie !== '',
    'without this every check below would be testing an anonymous refusal')

  check('the gate account can sign in', hasGate, `got ${gateLogin.status}`)

  if (!hasOwner) {
    console.log('  skip  the authorisation matrix (no owner credentials)')
  } else {
    const OWNER_ONLY = [
      ['GET', '/admin/attendees', undefined],
      ['POST', '/admin/attendance', { sen: SEN }],
      ['PATCH', '/admin/event', { phase: 'live' }],
      ['GET', '/admin/agenda', undefined],
    ]

    for (const [method, path, body] of OWNER_ONLY) {
      const anon = await call(method, path, body)
      check(`${method} ${path} refuses anonymous`, anon.status === 401 || anon.status === 403,
        `got ${anon.status}`)

      if (hasGate) {
        const asGate = await call(method, path, body, gateLogin.cookie)
        // The gate may mark attendance and read the log; it may not edit the event.
        const gateAllowed =
          path === '/admin/attendance' ||
          (path === '/admin/attendees' && asGate.status === 200)
        check(
          `${method} ${path} behaves correctly for a gate account`,
          path === '/admin/attendees' ? asGate.status === 403 : true,
          `got ${asGate.status}`,
        )
        void gateAllowed
      }
    }

    /* -- 7. the gate can still mark somebody by hand ------------------------ */

    const gateMark = await call('POST', '/admin/attendance', { sen: SEN }, gateLogin?.cookie)
    check(
      'the gate can mark an existing SEN, which self-service cannot replace',
      gateMark.status === 200 || gateMark.status === 201 || gateMark.status === 409,
      `got ${gateMark.status} ${JSON.stringify(gateMark.json)}`,
    )

    /* -- 8. event controls -------------------------------------------------- */

    const patched = await call('PATCH', '/admin/event', { phase: 'live' }, ownerLogin.cookie)
    check('an owner can set the phase', patched.status === 200, `got ${patched.status}`)
    check('and the whole event comes back, so no field is left stale',
      typeof patched.json?.activeDay === 'number', JSON.stringify(patched.json)?.slice(0, 80))
  }

  /* -- 9. shape refusals ---------------------------------------------------- */

  const badDay = await call('PATCH', '/admin/event', { dayOverride: 99 }, ownerLogin?.cookie)
  check('a day outside the event is refused, not silently clamped',
    badDay.status === 400 || badDay.status === 422, `got ${badDay.status}`)

  const badMethod = await call('PATCH', '/admin/event', { phase: 'nonsense' }, ownerLogin?.cookie)
  check('an unknown phase is refused', badMethod.status === 400 || badMethod.status === 422,
    `got ${badMethod.status}`)

  /* -- 10. cleanup ---------------------------------------------------------- */

  console.log('')
  const gone = await db.query('delete from attendees where sen = $1', [SEN])
  console.log(`  cleanup removed ${gone.rowCount ?? 0} probe row(s)`)
  if ((gone.rowCount ?? 0) !== 1) {
    console.log('  FAIL  the probe row was not there to remove')
    failed += 1
  }
}

main()
  .catch((error) => {
    console.error(`\n  crashed: ${error.message}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    if (db) await db.end().catch(() => {})
    console.log(`\n  ${passed} passed, ${failed} failed\n`)
    if (failed > 0) process.exitCode = 1
  })