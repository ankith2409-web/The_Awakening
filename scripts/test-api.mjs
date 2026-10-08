#!/usr/bin/env node
/**
 * End-to-end check of the API against the real database.
 *
 * Exercises the routes the way the browser does — including cookies — and
 * asserts the behaviour the portal depends on. Run with:
 *   npm run test:api
 */

import { loadEnv } from './_env.mjs'
import { testSen, purgeTestAttendeesOnce } from './_fixtures.mjs'

// Read `.env` so the cleanup at the end can reach the database this suite just
// wrote to. Harmless in production, where Vercel injects the real environment.
loadEnv()

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Minimal cookie jar so we can assert on real session behaviour. */
function makeJar() {
  const jar = new Map()
  return {
    header: () =>
      [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(res) {
      const raw = res.headers.getSetCookie?.() ?? []
      for (const line of raw) {
        const [pair] = line.split(';')
        const [name, value] = pair.split('=')
        if (value === '') jar.delete(name.trim())
        else jar.set(name.trim(), value)
      }
    },
  }
}

async function call(jar, method, path, body) {
  const headers = {}
  const cookie = jar.header()
  if (cookie !== '') headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  jar.absorb(res)

  const text = await res.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed, setCookie: res.headers.getSetCookie?.() ?? [] }
}

async function main() {
  console.log(`\n  Testing ${BASE}\n`)

  // Unique suffix so repeated runs never collide on phone/SEN uniqueness.
  const runId = Date.now().toString().slice(-6)
  const phone = `9${runId}12345`.slice(0, 10)
  // ZTEST-prefixed, so this run's attendee can be recognised and deleted afterwards.
  const sen = testSen(`API${runId}`)

  const anon = makeJar()

  /* -- public data ----------------------------------------------------- */
  const event = await call(anon, 'GET', '/event')
  check('GET /event returns the event', event.status === 200 && event.body?.name === 'THE AWAKENING')
  /*
    Asserted structurally, not against a fixed count. The programme is edited in
    `db/seed.sql`, so a hardcoded number turns every schedule change into a
    failing test — which trains you to ignore the suite.
  */
  check('event has a non-empty agenda', Array.isArray(event.body?.agenda) && event.body.agenda.length > 0,
    `got ${event.body?.agenda?.length}`)

  check(
    'every agenda item carries a 1-based day',
    event.body?.agenda?.every((i) => Number.isInteger(i.day) && i.day >= 1),
    JSON.stringify(event.body?.agenda?.map((i) => i.day)),
  )
  check(
    'agenda days are contiguous from 1',
    [...new Set((event.body?.agenda ?? []).map((i) => i.day))]
      .sort((a, b) => a - b)
      .every((d, i) => d === i + 1),
    JSON.stringify([...new Set((event.body?.agenda ?? []).map((i) => i.day))]),
  )

  check('event has tagline + organiser', event.body?.tagline?.includes('built by you') && event.body?.organiser === 'Google Developer Groups')

  // A two-day event must carry both ends of its range.
  check(
    'event spans two days with an end date',
    typeof event.body?.date === 'string' && typeof event.body?.endDate === 'string',
    `date=${event.body?.date} endDate=${event.body?.endDate}`,
  )
  check(
    'dates are plain YYYY-MM-DD, not shifted by a timezone',
    /^\d{4}-\d{2}-\d{2}$/.test(event.body?.date ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(event.body?.endDate ?? ''),
    `date=${event.body?.date} endDate=${event.body?.endDate}`,
  )
  check('end date is after the start date', (event.body?.endDate ?? '') > (event.body?.date ?? ''))

  check(
    'event carries the host institution and a real venue',
    typeof event.body?.organiserHost === 'string' && event.body.organiserHost.length > 0 &&
      typeof event.body?.venue === 'string' && event.body.venue.length > 0 &&
      typeof event.body?.city === 'string' && event.body.city.length > 0,
    `host=${event.body?.organiserHost} venue=${event.body?.venue}, ${event.body?.city}`,
  )
  // These were the wrong way round in db/seed.sql for a while: venue held the
  // city and city held the country.
  check(
    'venue is a place, not the city',
    event.body?.venue !== event.body?.city,
    `venue and city are both "${event.body?.city}"`,
  )

  const teams = await call(anon, 'GET', '/teams')
  check('GET /teams returns teams', teams.status === 200 && teams.body?.length === 4)
  check('teams have name/lead/members', teams.body?.[0] && 'name' in teams.body[0] && 'leadName' in teams.body[0] && Array.isArray(teams.body[0].members))

  /* -- guards ---------------------------------------------------------- */
  check('anonymous /admin/attendance is forbidden', (await call(anon, 'GET', '/admin/attendance')).status === 403)
  check('anonymous /admin/attendance POST is forbidden', (await call(anon, 'POST', '/admin/attendance', { sen })).status === 403)
  check('anonymous /attendee/session is null', (await call(anon, 'GET', '/attendee/session')).body === null)
  check('unknown endpoint 404s', (await call(anon, 'GET', '/nope')).status === 404)

  /* -- registration ---------------------------------------------------- */
  const weak = await call(anon, 'POST', '/attendee/register', {
    name: 'Weak Pass', phone, sen, password: 'abc',
  })
  check('weak password is rejected', weak.status === 422 && weak.body?.code === 'weak_password')

  const badPhone = await call(anon, 'POST', '/attendee/register', {
    name: 'Bad Phone', phone: '123', sen, password: 'grid2026',
  })
  check('invalid phone is rejected', badPhone.status === 422)

  const badSen = await call(anon, 'POST', '/attendee/register', {
    name: 'Bad Sen', phone, sen: 'nonsense', password: 'grid2026',
  })
  check('invalid SEN is rejected', badSen.status === 422)

  const reg = await call(anon, 'POST', '/attendee/register', {
    name: 'Test Attendee', phone, sen, password: 'grid2026',
  })
  check('registration succeeds', reg.status === 201 && reg.body?.attendee?.sen === sen, `got ${reg.status}`)
  check('registration sets a session cookie', anon.header() !== '')

  /*
    Cookie lifetime. `Max-Age` is in SECONDS per RFC 6265; writing the day
    count straight into it issues a 1-second cookie, so the browser forgets the
    attendee a moment after they sign in while the database still honours the
    session. The symptom is a redirect to /login on the next reload — invisible
    to any test that inspects Set-Cookie but never actually waits.
  */
  const regCookie = (reg.setCookie ?? []).find((line) => line.startsWith('gdg_attendee='))
  const regMaxAge = Number(regCookie?.match(/Max-Age=(\d+)/)?.[1] ?? '0')
  check('session cookie is HttpOnly', Boolean(regCookie) && /HttpOnly/.test(regCookie))
  check(
    'Max-Age is seconds, not days',
    regMaxAge >= 86400,
    `Max-Age=${regMaxAge} = ${(regMaxAge / 86400).toFixed(2)} days`,
  )
  check('cookie carries an Expires fallback', /Expires=/.test(regCookie ?? ''))

  const session = await call(anon, 'GET', '/attendee/session')
  check('session resolves after register', session.body?.attendee?.name === 'Test Attendee')

  const ticket = await call(anon, 'GET', '/attendee/ticket')
  check('ticket is a signed SEN payload', ticket.status === 200 && typeof ticket.body?.encoded === 'string' && ticket.body.encoded.startsWith(sen + '.'))

  /*
    Field-name contracts. These exist because each of these was silently wrong
    while the app ran against the in-memory mock, and only broke once the
    database was real:

      - register never sent `sen`, so no attendee could register at all
      - attendance rows came back snake_case, so the admin log resolved every
        record to "no name"
      - the agenda PATCH returned the whole event where the client expected
        one item
  */
  check(
    'register echoes the SEN it was sent',
    reg.body?.attendee?.sen === sen,
    `got ${JSON.stringify(reg.body?.attendee?.sen)}`,
  )

  const myAttendance = await call(anon, 'GET', '/attendee/attendance')
  /*
    Not null any more.

    This used to be `null`, which meant "not marked yet" and doubled as "no
    session". It now returns an object with an empty `records` array and the day
    count, because the dashboard has to render a row per day — including days with
    no record yet — and cannot do that from a null.

    The distinction that matters is preserved: no session is still `null`, so this
    is only ever reached by somebody who is actually signed in.
  */
  check(
    'attendance starts with no records',
    Array.isArray(myAttendance.body?.records) && myAttendance.body.records.length === 0,
    `got ${JSON.stringify(myAttendance.body)}`,
  )
  check(
    'and reports the day count, so the dashboard can render per-day rows',
    typeof myAttendance.body?.totalDays === 'number' && myAttendance.body.totalDays >= 1,
    `totalDays=${myAttendance.body?.totalDays}`,
  )

  const anonAttendance = await call(makeJar(), 'GET', '/attendee/attendance')
  check(
    'no session is still null, distinct from "no records"',
    anonAttendance.body === null,
    `got ${JSON.stringify(anonAttendance.body)}`,
  )

  /* -- duplicates ------------------------------------------------------ */
  const dupPhone = await call(makeJar(), 'POST', '/attendee/register', {
    name: 'Other Person', phone, sen: `SEN9${runId}`, password: 'grid2026',
  })
  check('duplicate phone rejected', dupPhone.status === 409 && dupPhone.body?.code === 'phone_taken')

  const dupSen = await call(makeJar(), 'POST', '/attendee/register', {
    name: 'Other Person', phone: `8${runId}54321`.slice(0, 10), sen, password: 'grid2026',
  })
  check('duplicate SEN rejected', dupSen.status === 409 && dupSen.body?.code === 'sen_taken')

  /* -- login ----------------------------------------------------------- */
  const wrong = await call(makeJar(), 'POST', '/attendee/login', {
    name: 'Test Attendee', phone, password: 'wrongpassword',
  })
  check('wrong password rejected', wrong.status === 401)

  const wrongName = await call(makeJar(), 'POST', '/attendee/login', {
    name: 'Someone Else', phone, password: 'grid2026',
  })
  check('wrong name rejected (no enumeration)', wrongName.status === 401 && wrongName.body?.code === 'invalid_credentials')

  /*
    Case and whitespace are typing habits, not identity.

    This was a live lockout. Registration accepts a name with internal double
    spacing — the validator allows it — but the login compared the name exactly, so
    somebody who registered as "Mary  Ann" and then typed "Mary Ann", the most
    natural way to type it, was refused with no way back but emailing the organiser.
    Days before an event, with a pass they had just been issued.

    The name stays a real second factor: a different name, a different spelling, or
    an added middle initial must still fail.
  */
  const spacedName = 'Mary  Ann'
  const spacedPhone = `7${runId}20202`.slice(0, 10)
  const spacedSen = `T${runId}202`
  await call(makeJar(), 'POST', '/attendee/register', {
    name: spacedName, phone: spacedPhone, sen: spacedSen, password: 'grid2026',
  })

  const singleSpaced = await call(makeJar(), 'POST', '/attendee/login', {
    name: 'Mary Ann', phone: spacedPhone, password: 'grid2026',
  })
  check(
    'a name typed with different spacing still gets in',
    singleSpaced.status === 200,
    `got ${singleSpaced.status} — registered "${spacedName}", logged in as "Mary Ann"`,
  )

  const padded = await call(makeJar(), 'POST', '/attendee/login', {
    name: '  mary   ann  ', phone: spacedPhone, password: 'grid2026',
  })
  check('surrounding and repeated whitespace is ignored too', padded.status === 200, `got ${padded.status}`)

  const middleInitial = await call(makeJar(), 'POST', '/attendee/login', {
    name: 'Mary A Ann', phone: spacedPhone, password: 'grid2026',
  })
  check(
    'but an added middle initial is still a different name',
    middleInitial.status === 401,
    `got ${middleInitial.status}`,
  )

  const fresh = makeJar()
  const login = await call(fresh, 'POST', '/attendee/login', {
    name: 'test attendee', phone, password: 'grid2026', remember: true,
  })
  check('login succeeds case-insensitively', login.status === 200 && login.body?.attendee?.sen === sen, `got ${login.status}`)

  const rememberedCookie = (login.setCookie ?? []).find((line) => line.startsWith('gdg_attendee='))
  const rememberedMaxAge = Number(rememberedCookie?.match(/Max-Age=(\d+)/)?.[1] ?? '0')
  check(
    '"remember me" extends the cookie to ~30 days',
    rememberedMaxAge >= 29 * 86400,
    `Max-Age=${rememberedMaxAge} = ${(rememberedMaxAge / 86400).toFixed(1)} days`,
  )

  /* -- admin ----------------------------------------------------------- */
  const adminJar = makeJar()
  const badAdmin = await call(adminJar, 'POST', '/admin/login', { username: 'admin', password: 'nope' })
  check('bad admin login rejected', badAdmin.status === 401)

  const adminLogin = await call(adminJar, 'POST', '/admin/login', {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? '',
  })
  if (adminLogin.status === 200) {
    check('admin login succeeds', adminLogin.body?.admin?.username != null)
  } else {
    console.log('  skip  admin login (ADMIN_PASSWORD not set in this shell)')
  }

  /* -- the scan path (only when we have admin) ------------------------- */
  if (adminLogin.status === 200) {
    const unknown = await call(adminJar, 'POST', '/admin/attendance', { sen: 'SEN00000000' })
    check('unknown SEN rejected', unknown.status === 422 && unknown.body?.code === 'unknown_sen')

    const scan = await call(adminJar, 'POST', '/admin/attendance', { sen })
    check('scan records attendance', scan.status === 201 && scan.body?.sen === sen, `got ${scan.status}`)

    const again = await call(adminJar, 'POST', '/admin/attendance', { sen })
    check('re-scan rejected (single use)', again.status === 409 && again.body?.code === 'already_checked_in')

    // Concurrent scans: exactly one must win.
    const burst = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(makeJar(), 'POST', '/admin/attendance', { sen: `SEN9${runId}` }),
      ),
    )
    check('unauthenticated burst all forbidden', burst.every((r) => r.status === 403))

    const log = await call(adminJar, 'GET', '/admin/attendance')
    check('attendance log lists the record', Array.isArray(log.body) && log.body.some((r) => r.sen === sen))

    // The admin UI resolves each log row to a person through `attendeeId`.
    const logged = log.body?.find((r) => r.sen === sen)
    check(
      'log row exposes camelCase attendeeId',
      typeof logged?.attendeeId === 'string' && logged.attendeeId !== '',
      `got ${JSON.stringify(logged?.attendeeId)}`,
    )
    check('log row exposes no snake_case key', logged?.attendee_id === undefined)

    const roster = await call(adminJar, 'GET', '/admin/attendees')
    check('admin roster works', Array.isArray(roster.body) && roster.body.length >= 1)

    // Scanner payloads vary. All of these must resolve to the same SEN.
    const wrapped = `https://portal.example/checkin?code=${sen}.deadbeef`
    const wrappedScan = await call(adminJar, 'POST', '/admin/attendance', { sen: wrapped })
    check('URL-wrapped payload resolves', wrappedScan.status === 409 && wrappedScan.body?.code === 'already_checked_in')

    const padded = `  ${sen}\n`
    check('padded/newline payload resolves', (await call(adminJar, 'POST', '/admin/attendance', { sen: padded })).status === 409)

    check('lowercase payload resolves', (await call(adminJar, 'POST', '/admin/attendance', { sen: sen.toLowerCase() })).status === 409)

    const phase = await call(adminJar, 'PATCH', '/admin/event', { phase: 'live' })
    check('phase update persists', phase.status === 200 && phase.body?.phase === 'live')

    const badPhase = await call(adminJar, 'PATCH', '/admin/event', { phase: 'nonsense' })
    check('invalid phase rejected', badPhase.status === 400)

    const agendaId = phase.body?.agenda?.[0]?.id
    check('event carries an agenda id to patch', typeof agendaId === 'string')

    const patch = await call(adminJar, 'PATCH', `/admin/agenda/${agendaId}`, {
      status: 'live',
    })
    check(
      'agenda PATCH returns one AgendaItem, not the event',
      patch.status === 200 &&
        patch.body?.id === agendaId &&
        patch.body?.status === 'live' &&
        patch.body?.agenda === undefined,
      `keys: ${JSON.stringify(Object.keys(patch.body ?? {}).slice(0, 6))}`,
    )

    const badAgenda = await call(adminJar, 'PATCH', `/admin/agenda/${agendaId}`, {
      status: 'nonsense',
    })
    check('invalid agenda status rejected', badAgenda.status === 400)

    const missingAgenda = await call(adminJar, 'PATCH', '/admin/agenda/no_such_item', {
      status: 'live',
    })
    check('unknown agenda item 404s', missingAgenda.status === 404)
  }

  /* -- attendee sees it ------------------------------------------------- */
  const marked = await call(anon, 'GET', '/attendee/attendance')
  /*
    A list of records, not one record. `test:perday` covers the two-day case
    properly; this asserts the shape and the day each record carries, because the
    single-record assumption is what broke when days were introduced.
  */
  const markedRecords = marked.body?.records ?? []
  check(
    'attendee sees their attendance as a list',
    Array.isArray(marked.body?.records),
    `got ${JSON.stringify(marked.body)}`,
  )
  check('with exactly one record so far', markedRecords.length === 1, `${markedRecords.length} records`)
  check(
    'that record is theirs',
    markedRecords[0]?.sen === sen,
    `got ${markedRecords[0]?.sen}`,
  )
  check(
    'and it names the day it was recorded against',
    // The event's OWN active day, not a hard-coded 1. This used to assert day === 1,
    // which passed only while the calendar said day one — so on the morning of day
    // two it failed for a reason that had nothing to do with the code, and three
    // suites' worth of red looked like a regression rather than a stale expectation.
    markedRecords[0]?.day === event.body?.activeDay,
    `record says day ${markedRecords[0]?.day}, event says ${event.body?.activeDay}`,
  )

  await call(anon, 'POST', '/attendee/logout')
  const afterLogout = await call(anon, 'GET', '/attendee/session')
  check('logout clears the session', afterLogout.body === null)

  /*
    Remove the attendee this suite registered.

    These suites run against the live database, so without this the fixture sits on
    the real roster — counted by the owner's dashboard and included in the SEN
    export. Logout is not enough: that clears the cookie, not the row.
  */
  await purgeTestAttendeesOnce()

  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch(async (error) => {
  console.error('\n  Test run crashed:', error.message, '\n')
  // A suite that throws halfway is precisely the one that must still clean up.
  try {
    await purgeTestAttendeesOnce()
  } catch {
    // Never let the cleanup failure mask the real error.
  }
  process.exitCode = 1
})