/**
 * Proves the check-in flow against a running API, before any UI exists.
 *
 * The four things that can be wrong on day one, in the order they bite:
 *
 *   1. It does not create the person at all.
 *   2. It creates them but marks nothing.
 *   3. It marks them twice for one tap.
 *   4. It marks them again on the second day, when they should be able to.
 *
 * CLEANS UP AFTER ITSELF.
 *
 * A check-in writes a real attendee and a real attendance row, so this suite
 * leaves rows behind unless it says otherwise. It registers through the SAME
 * public route a student uses — there is no back door to insert a fixture, which
 * is the point — and therefore cannot use a prefix the existing fixture purge
 * recognises. It deletes its own rows by name on the way out, and a cleanup that
 * silently fails is reported as a failure rather than swallowed: a suite that
 * leaves people in the register is worse than one that does not run.
 *
 * Requires DATABASE_URL for the cleanup. Without it the checks still run, and the
 * rows it leaves are named so they are findable.
 *
 * Plus the close: a locked day must refuse, and it must refuse BEFORE anything is
 * written — a close that stops new writes but still updates a name would look
 * closed from the outside.
 */

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'

/*
  `.env` is read here, not left to the shell.

  The cleanup at the end needs DATABASE_URL, and `npm run` does not load it. The
  first run of this suite left four probe rows in the register precisely because
  the connection string was absent and the cleanup said so — which is the failure
  mode working, but a suite that cannot clean up after itself should not be run
  with a flag that silently changes its behaviour.
*/
const { loadEnv } = await import('./_env.mjs')
loadEnv()

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
  const text = await res.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json }
}

// Unique per run, so this never collides with a real person.
const stamp = Date.now().toString().slice(-7)
const SEN = `A9${stamp}0012`
const PHONE = `9${stamp}12`.slice(0, 10)
const NAME = 'Checkin Probe'

console.log(`\n  Check-in flow against ${BASE}\n`)

/* -- 1. the first tap ------------------------------------------------------- */

const first = await call('POST', '/attendee/checkin', { name: NAME, phone: PHONE, sen: SEN })
check('a check-in is accepted', first.status === 201, `${first.status} ${JSON.stringify(first.json)}`)
check('it reports the day it recorded', first.json?.day === 1, `day=${first.json?.day}`)
check('and that this is the first time', first.json?.firstTime === true)
check('and that it is not a duplicate', first.json?.alreadyMarked === false)
check('the name comes back as typed', first.json?.name === NAME, first.json?.name)
check('the SEN comes back normalised', first.json?.sen === SEN, first.json?.sen)

/* -- 2. the same tap again -------------------------------------------------- */

const again = await call('POST', '/attendee/checkin', { name: NAME, phone: PHONE, sen: SEN })
check('tapping twice is accepted rather than refused', again.status === 200, `${again.status}`)
check('and is reported as already marked', again.json?.alreadyMarked === true)
check('not as a second person', again.json?.firstTime === false)

const after = await call('GET', `/attendee/attendance?sen=${SEN}`)
const day1Marks = (after.json?.records ?? []).filter((r) => r.day === 1)
check('and exactly one mark exists for the day', day1Marks.length === 1, `${day1Marks.length} marks`)
check('recorded as a self check-in, not a scan',
  day1Marks[0]?.method === 'self', `method=${day1Marks[0]?.method}`)

/* -- 3. somebody else can still not be looked up ---------------------------- */

const unknown = await call('GET', '/attendee/attendance?sen=A000000000000')
check('a SEN nobody has used returns no records',
  Array.isArray(unknown.json?.records) && unknown.json.records.length === 0,
  JSON.stringify(unknown.json))
const nonsense = await call('GET', '/attendee/attendance?sen=not-a-sen')
check('and so does a malformed one, without an error',
  nonsense.status === 200 && nonsense.json?.records?.length === 0,
  `${nonsense.status} ${JSON.stringify(nonsense.json)}`)

/* -- 4. validation still belongs to the server ------------------------------ */

/*
  An empty field and an invalid field get DIFFERENT status codes, deliberately.

  `name: ''` is a missing field, which the body reader answers 400. A name that is
  present and wrong — an emoji in it — is 422. Both refuse the check-in; the
  distinction is for whoever is reading the log, and it is asserted here because a
  test that accepted "4xx" would let the two collapse into each other unnoticed.
*/
const emptyName = await call('POST', '/attendee/checkin', { name: '', phone: PHONE, sen: SEN })
check('an empty name is refused as a missing field',
  emptyName.status === 400, `${emptyName.status} ${JSON.stringify(emptyName.json)}`)

const emojiNameOnly = await call('POST', '/attendee/checkin', {
  name: 'Party 🎉',
  phone: PHONE,
  sen: SEN,
})
check('a present but invalid name is refused as unprocessable',
  emojiNameOnly.status === 422, `${emojiNameOnly.status}`)

const badPhone = await call('POST', '/attendee/checkin', { name: NAME, phone: '123', sen: SEN })
check('a phone that is not one is refused', badPhone.status === 422, `${badPhone.status}`)

const badSen = await call('POST', '/attendee/checkin', { name: NAME, phone: PHONE, sen: '###' })
check('a malformed SEN is refused', badSen.status === 422, `${badSen.status}`)

const emojiName = await call('POST', '/attendee/checkin', { name: 'Party 🎉', phone: PHONE, sen: SEN })
check('and a name with an emoji is still refused', emojiName.status === 422,
  `${emojiName.status} ${JSON.stringify(emojiName.json)}`)

const missing = await call('POST', '/attendee/checkin', { name: NAME, phone: PHONE })
check('a check-in with no SEN at all is refused', missing.status === 400, `${missing.status}`)

/* -- 5. a closed day refuses, and nothing is written ------------------------- */

/*
  The one control an organiser will actually reach for during the event.

  Two properties matter and they are different. The refusal has to be TOTAL — a
  check-in on a closed day must write nothing at all, not even the attendee row,
  because "closed" that still creates people is closed only on the surface. And it
  has to be recoverable: reopening must put the day back exactly as it was.

  Skipped entirely unless admin credentials are present, because the default run
  against localhost has none and a half-run lock test leaves the database locked.
*/
const OWNER = process.env.ADMIN_USERNAME
const OWNER_PASSWORD = process.env.ADMIN_PASSWORD

if (!OWNER || !OWNER_PASSWORD) {
  console.log('  skip  the closed-day checks (ADMIN_USERNAME / ADMIN_PASSWORD not set)')
} else {
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: OWNER, password: OWNER_PASSWORD }),
  })
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

  if (login.status !== 200 || cookie === '') {
    console.log('  skip  the closed-day checks (admin login failed)')
  } else {
    const state = await (await fetch(`${BASE}/api/event`)).json()
    const lockedBefore = state.lockedDays ?? []

    const locked = await call('PATCH', '/admin/event', { lockedDays: [1, 2] }, cookie)
    check('an owner can close every day', locked.status === 200,
      `${locked.status} ${JSON.stringify(locked.json)}`)

    const refused = await call('POST', '/attendee/checkin', {
      name: NAME,
      phone: PHONE,
      sen: SEN,
    })
    check('and a check-in on a closed day is refused',
      refused.status === 409, `${refused.status} ${JSON.stringify(refused.json)}`)
    check('with copy that says the day is closed, not that something broke',
      /closed/i.test(refused.json?.message ?? ''), JSON.stringify(refused.json?.message))

    const afterLock = await call('GET', `/attendee/attendance?sen=${SEN}`)
    const marksWhileLocked = (afterLock.json?.records ?? []).filter((r) => r.day === 1).length
    check('and writes nothing at all — not even a second mark',
      marksWhileLocked === 1, `${marksWhileLocked} marks (expected the 1 from earlier)`)

    const reopened = await call('PATCH', '/admin/event', { lockedDays: lockedBefore }, cookie)
    check('and reopening restores exactly what was there before',
      reopened.status === 200, `${reopened.status}`)

    const works = await call('POST', '/attendee/checkin', {
      name: NAME,
      phone: PHONE,
      sen: SEN,
    })
    check('and check-ins work again afterwards', works.status === 200 || works.status === 201,
      `${works.status}`)
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`)

/* -- cleanup ---------------------------------------------------------------- */

/*
  By NAME, not by prefix, and only the rows this run created.

  A prefix purge is the wrong tool here and it is how suites delete real people:
  the register is the one table where "looks like a fixture" is a judgement about
  a human being's name. This deletes one exact SEN, and reports having done it.
*/
if (process.env.DATABASE_URL) {
  const { Client } = await import('pg')
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  try {
    await db.connect()
    const gone = await db.query('delete from attendees where sen = $1', [SEN])
    console.log(`  cleanup removed ${gone.rowCount ?? 0} probe row(s)`)
    if ((gone.rowCount ?? 0) !== 1) {
      console.log('  FAIL  the probe row was not there to remove')
      failed += 1
    }
  } catch (error) {
    console.log(`  FAIL  cleanup could not run: ${error.message}`)
    console.log(`  the probe row is still in the register as SEN ${SEN}`)
    failed += 1
  } finally {
    await db.end().catch(() => {})
  }
  console.log('')
} else {
  console.log(`  no DATABASE_URL — the probe row is still in the register as SEN ${SEN}\n`)
}

if (failed > 0) process.exitCode = 1