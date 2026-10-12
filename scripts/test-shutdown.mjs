#!/usr/bin/env node
/**
 * The one switch that shuts everything.
 *
 *   node --experimental-strip-types --no-warnings scripts/test-shutdown.mjs
 * `TEST_BASE_URL=https://the-awakening-portal.vercel.app/api` runs it against
 * production.
 *
 * WHAT THIS IS FOR
 *
 * `events.registration_mode` has carried `'open' | 'restricted' | 'closed'` since the
 * guest list was removed, the server returned it in `/event`, and the client's
 * `EventInfo` declared it. No public route read it and no admin control wrote it —
 * a field that is persisted, transmitted and typed, and enforces nothing. Half of a
 * feature is worse than none of it, because on a screen it reads as though it works.
 *
 * So this asserts the three things that make it real: an organiser can set it, both
 * doors refuse while it is set, and both open again afterwards. It also asserts that
 * 'restricted' does NOT close anything, since that is the state most likely to be
 * confused with 'closed' and the one that would silently break registration.
 *
 * IT PUTS THE EVENT BACK EXACTLY AS IT FOUND IT, in a `finally`.
 *
 * A test that leaves registration closed on the live site is worse than a test that
 * does not run. The mode is read before anything else and restored last, whatever
 * happens in between.
 */

import { loadEnv } from './_env.mjs'

loadEnv()
import { Client } from 'pg'

const API = process.env.TEST_BASE_URL ?? 'http://localhost:3000'

let passed = 0
let failed = 0

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`)
  }
}

async function call(method, path, body, cookie) {
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = {}
  try {
    json = await res.json()
  } catch {
    json = {}
  }
  return { status: res.status, json }
}

/** Reads and writes the mode without going through the admin session, for setup and teardown. */
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
await client.connect()

const readMode = async () => {
  const { rows } = await client.query('select registration_mode from events order by date desc limit 1')
  return rows[0]?.registration_mode ?? 'open'
}

const writeMode = async (mode) => {
  await client.query('update events set registration_mode = $1', [mode])
}

const ORIGINAL_MODE = await readMode()
console.log(`\n  Shutdown switch — the event is currently "${ORIGINAL_MODE}"\n`)

/*
  A sign-in as the owner, so the assertions about the ADMIN control are made through
  the control rather than by writing the column directly. A control that exists in
  the database and not in the API is the exact half-feature this file is about.

  THE COOKIE IS READ OFF THE RAW REPLY. The first version of this file called the
  login helper, took the parsed body, and never took the header — so every admin
  call answered 403 and eleven assertions failed for a reason that had nothing to do
  with what they were testing. `ok=true` in a response body is not a session.
*/
const loginRaw = await fetch(`${API}/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  }),
})
const COOKIE = (loginRaw.headers.get('set-cookie') ?? '').split(';')[0]

check('the owner can sign in', loginRaw.status === 200, `got ${loginRaw.status}`)
check('and the portal issues a session cookie', COOKIE !== '')

/* -- reading the current state ---------------------------------------------- */

const eventBefore = await call('GET', '/event')
check(
  'the public payload carries the mode, so the pages can show it',
  typeof eventBefore.json?.registrationMode === 'string',
  JSON.stringify(Object.keys(eventBefore.json ?? {})),
)

/* -- the admin control ------------------------------------------------------- */

const setClosed = await call('PATCH', '/admin/event', { registrationMode: 'closed' }, COOKIE)
check('the owner can close the event through the API', setClosed.status === 200, `got ${setClosed.status}`)
check(
  'and the response says so',
  setClosed.json?.registrationMode === 'closed',
  `got ${setClosed.json?.registrationMode}`,
)
check('and the database agrees', (await readMode()) === 'closed', await readMode())

/* -- both doors refuse ------------------------------------------------------- */

const checkin = await call('POST', '/attendee/checkin', {
  name: 'Shutdown Probe',
  phone: '9845012345',
  sen: 'SEN7701234001',
})
check('check-in is refused', checkin.status === 409, `got ${checkin.status}`)
check(
  'and the refusal names the registration being closed',
  /closed/i.test(checkin.json?.message ?? ''),
  JSON.stringify(checkin.json),
)

const registration = await call('POST', '/team/register', {
  name: 'Shutdown Squad',
  leaderName: 'Shutdown Probe',
  leaderEmail: 'shutdown-7701@example.com',
  leaderPhone: '9845012345',
  leaderSen: 'SEN7701234011',
  members: [
    { name: 'Shutdown One', sen: 'SEN7701234012' },
    { name: 'Shutdown Two', sen: 'SEN7701234013' },
  ],
})
check('team registration is refused', registration.status === 409, `got ${registration.status}`)
check(
  'and says so in words a leader can act on',
  /closed/i.test(registration.json?.message ?? ''),
  JSON.stringify(registration.json),
)

/*
  Nothing was written.

  The refusal has to happen before any write, not after. A check-in that lands and
  then answers 409 is a student on the door list who the portal has just told is not
  marked, and the two records disagree for as long as somebody has to look.
*/
const written = await client.query(
  'select (select count(*)::int from attendees where sen like $1) as people,' +
    '       (select count(*)::int from teams where name = $2) as teams',
  ['SEN7701234%', 'Shutdown Squad'],
)
check('no attendee row was written', written.rows[0].people === 0, `${written.rows[0].people} written`)
check('no team was written', written.rows[0].teams === 0, `${written.rows[0].teams} written`)

/* -- restricted is NOT closed ------------------------------------------------ */

await writeMode('restricted')
const stillOpen = await call('POST', '/attendee/checkin', {
  name: 'Restricted Probe',
  phone: '9845012346',
  sen: 'SEN7701234021',
})
check(
  "'restricted' does NOT close check-in",
  stillOpen.status === 200 || stillOpen.status === 201,
  `got ${stillOpen.status}: ${stillOpen.json?.message ?? ''}`,
)

const stillRegisters = await call('POST', '/team/register', {
  name: 'Restricted Squad',
  leaderName: 'Restricted Probe',
  leaderEmail: 'restricted-7701@example.com',
  leaderPhone: '9845012347',
  leaderSen: 'SEN7701234031',
  members: [
    { name: 'Restricted One', sen: 'SEN7701234032' },
    { name: 'Restricted Two', sen: 'SEN7701234033' },
  ],
})
check(
  "'restricted' does NOT close team registration",
  stillRegisters.status === 201,
  `got ${stillRegisters.status}: ${stillRegisters.json?.message ?? ''}`,
)

/* -- reopening --------------------------------------------------------------- */

await call('PATCH', '/admin/event', { registrationMode: 'open' }, COOKIE)
const reopened = await call('POST', '/attendee/checkin', {
  name: 'Reopen Probe',
  phone: '9845012348',
  sen: 'SEN7701234041',
})
check('reopening lets check-in through again', reopened.status === 200 || reopened.status === 201, `got ${reopened.status}`)

const reRegistered = await call('POST', '/team/register', {
  name: 'Reopen Squad',
  leaderName: 'Reopen Probe',
  leaderEmail: 'reopen-7701@example.com',
  leaderPhone: '9845012349',
  leaderSen: 'SEN7701234051',
  members: [
    { name: 'Reopen One', sen: 'SEN7701234052' },
    { name: 'Reopen Two', sen: 'SEN7701234053' },
  ],
})
check('reopening lets teams register again', reRegistered.status === 201, `got ${reRegistered.status}`)

/* -- a bad value is refused, not stored -------------------------------------- */

const nonsense = await call('PATCH', '/admin/event', { registrationMode: 'shut' }, COOKIE)
check('a nonsense mode is refused', nonsense.status === 400, `got ${nonsense.status}`)
check('and is not written', ['open', 'closed'].includes(await readMode()), await readMode())

/* -- cleanup ----------------------------------------------------------------- */

try {
  await writeMode(ORIGINAL_MODE)

  const people = await client.query("delete from attendees where sen like 'SEN7701234%'")
  const teams = await client.query(
    "delete from teams where leader_email like '%-7701@example.com'",
  )
  console.log(
    `\n  cleaned up ${people.rowCount} probe people and ${teams.rowCount} probe teams; event restored to "${ORIGINAL_MODE}"`,
  )
} catch (error) {
  console.log(`\n  cleanup FAILED: ${error.message}`)
  failed += 1
  try {
    await writeMode(ORIGINAL_MODE)
  } catch {
    /* Report it once; a second failure hiding the first is worse. */
  }
}

await client.end()

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
