#!/usr/bin/env node
/**
 * Day lock: closing attendance for a day, and what closing must NOT do.
 *
 * The feature exists because attendance is append-only with no edit and no delete
 * anywhere in the product. Once a day's SEN list has gone out for certificates, a
 * late scan cannot be taken back, so the only honest option is to stop accepting
 * them. That makes the lock a control with real consequences, and it makes the
 * second half of this suite the important half: a lock that stops marking and also
 * hides the record of who came has introduced a worse problem than the one it
 * solved.
 *
 * Driven through the real API against a real database, and cleaned up after
 * itself — including the override and the lock, which are restored whatever
 * happens, because leaving either behind would misfile or block every later scan on
 * the live site.
 *
 *   ADMIN_USERNAME / ADMIN_PASSWORD, and DATABASE_URL. TEST_BASE_URL for hosted.
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
  return { status: res.status, body: parsed, cookie: setCookie, text }
}

const stamp = Date.now().toString().slice(-9)
const PASSWORD = 'probe2026pass'
const PHONE = `7${stamp}`.slice(0, 10).padEnd(10, '4')

const SEN_OPEN = testSen(`OPEN${stamp}`)
const SEN_LOCKED = testSen(`LOCK${stamp}`)
const SEN_ALREADY = testSen(`DONE${stamp}`)

let db = null
let originalOverride = null

async function setLocks(days) {
  await db.query(`update events set locked_days = $1 where id = 'evt_awakening_2026'`, [days])
}

async function setOverride(day) {
  await db.query(`update events set day_override = $1 where id = 'evt_awakening_2026'`, [day])
}

async function cleanup() {
  if (!db) return

  /*
    Restore the day and the locks FIRST, and unconditionally.

    The day restore and the lock clear are the two that change what the live portal
    does, so they must not sit behind a fixture purge that can throw. An earlier
    version purged first, unguarded — a throw there left the event pinned and every
    scan filing into the wrong day, which is how `day_override` was found set to 2
    on 2026-10-07, eight days before the event.
  */
  try {
    await setLocks([])
    await setOverride(originalOverride)
  } catch (error) {
    console.error(`\n  FATAL: could not restore the event day — ${error.message}`)
    console.error('  Run:  update events set day_override = null, locked_days = \'{}\';')
    process.exitCode = 1
    return
  }

  await purgeTestAttendees(db)
}

async function main() {
  console.log(`\n  Testing ${BASE}\n`)

  if (!process.env.DATABASE_URL) {
    console.log('  DATABASE_URL is not set — this suite locks the live day.\n')
    process.exitCode = 1
    return
  }

  db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()

  const { rows: ev } = await db.query(
    `select day_override from events where id = 'evt_awakening_2026'`,
  )
  originalOverride = ev[0]?.day_override ?? null

  /*
    Refuse to ADOPT a pin this suite did not set.

    Same reason as `test:perday`: faithfully restoring whatever it finds is how a
    stale pin survives every run. Found set to 2 on 2026-10-07, eight days before the
    event, with the portal filing every scan under day two.

    Asserted, then reset rather than restored — a stale pin misfiles real attendance,
    which is worse than a failing test.
  */
  if (originalOverride !== null) {
    check(
      'the event was not already pinned to a day',
      false,
      `day_override was already ${originalOverride} — a previous run was interrupted. Reset to Auto (done) and re-run.`,
    )
    originalOverride = null
  } else {
    check('the event was not already pinned to a day', true)
  }

  // Start from a known state: day one live, nothing locked.
  await setOverride(1)
  await setLocks([])

  const owner = await call('POST', '/admin/login', {
    username: process.env.ADMIN_USERNAME ?? 'event.control',
    password: process.env.ADMIN_PASSWORD ?? '',
  })
  check('owner signed in', owner.status === 200, `got ${owner.status}`)
  if (owner.status !== 200) {
    await cleanup()
    await db.end()
    report()
    return
  }

  const gate = await call('POST', '/admin/login', {
    username: 'gate',
    password: process.env.ADMIN_PASSWORD_GATE ?? '',
  })
  check('gate signed in', gate.status === 200, `got ${gate.status}`)

  /* -- fixtures ---------------------------------------------------------- */

  for (const [sen, name] of [
    [SEN_OPEN, 'Lock Open Subject'],
    [SEN_LOCKED, 'Lock Closed Subject'],
    [SEN_ALREADY, 'Lock Done Subject'],
  ]) {
    const reg = await call('POST', '/attendee/register', {
      name,
      phone: `9${Math.floor(Math.random() * 1e8)}`.padEnd(10, '4'),
      sen,
      password: PASSWORD,
    })
    check(`registered ${name}`, reg.status === 201, `got ${reg.status}`)
  }

  /* -- an open day marks, as it always did ------------------------------- */

  const before = await call('POST', '/admin/attendance', { sen: SEN_OPEN }, owner.cookie)
  check(
    'an unlocked day still marks',
    before.status === 201 && before.body?.day === 1,
    `${before.status} day=${before.body?.day}`,
  )

  /* -- locking closes it ------------------------------------------------- */

  const set = await call('PATCH', '/admin/event', { lockedDays: [1] }, owner.cookie)
  check('owner can lock a day', set.status === 200, `got ${set.status}`)
  check(
    'the response reports the locked day',
    Array.isArray(set.body?.lockedDays) && set.body.lockedDays.includes(1),
    JSON.stringify(set.body?.lockedDays),
  )

  const refused = await call('POST', '/admin/attendance', { sen: SEN_LOCKED }, owner.cookie)
  check('a locked day refuses a new mark', refused.status === 409, `got ${refused.status}`)
  check('the refusal names the code', refused.body?.code === 'day_locked', refused.body?.code)
  check(
    'the refusal names the day, so a volunteer can act on it',
    typeof refused.body?.message === 'string' && refused.body.message.includes('day 1'),
    JSON.stringify(refused.body?.message),
  )

  /* -- locking does NOT rewrite history ---------------------------------- */

  const log = await call('GET', '/admin/attendance', undefined, owner.cookie)
  const stillThere = Array.isArray(log.body) && log.body.some((r) => r.sen === SEN_OPEN)
  check('a record made before the lock is still readable', stillThere)

  const exportRow = Array.isArray(log.body) && log.body.find((r) => r.sen === SEN_OPEN)
  check('the locked day keeps its day number on the record', exportRow?.day === 1, `day=${exportRow?.day}`)

  /* -- the lock is not a data edit --------------------------------------- */

  const count = await db.query('select count(*)::int as n from attendance where sen = $1', [SEN_LOCKED])
  check('nothing was written for the refused scan', count.rows[0].n === 0, `got ${count.rows[0].n}`)

  /* -- day two is unaffected by a day-one lock --------------------------- */

  await setOverride(2)
  const dayTwo = await call('POST', '/admin/attendance', { sen: SEN_LOCKED }, owner.cookie)
  check(
    'locking day one does not lock day two',
    dayTwo.status === 201 && dayTwo.body?.day === 2,
    `${dayTwo.status} day=${dayTwo.body?.day}`,
  )

  /* -- a gate account cannot open a lock --------------------------------- */

  if (gate.status === 200) {
    const refused2 = await call('PATCH', '/admin/event', { lockedDays: [] }, gate.cookie)
    check('a gate account cannot change the locks', refused2.status === 403, `got ${refused2.status}`)

    /*
      Back to day one first, which is the locked one.

      The previous block left the override on day two, so the live day was OPEN and
      this scan legitimately succeeded — the code was right and the assertion was
      wrong. Worth being explicit about, because the mistake is easy to repeat: a
      lock only applies to the day it names, and the live day is whichever the
      calendar or the override says.
    */
    await setOverride(1)
    const scanWhileLocked = await call('POST', '/admin/attendance', { sen: SEN_ALREADY }, gate.cookie)
    check(
      'a gate account is refused on a locked day too',
      scanWhileLocked.status === 409 && scanWhileLocked.body?.code === 'day_locked',
      `${scanWhileLocked.status}/${scanWhileLocked.body?.code}`,
    )
  }

  /* -- validation -------------------------------------------------------- */

  const badRange = await call('PATCH', '/admin/event', { lockedDays: [9] }, owner.cookie)
  check('a day outside the event is rejected', badRange.status === 400, `got ${badRange.status}`)

  const notArray = await call('PATCH', '/admin/event', { lockedDays: 1 }, owner.cookie)
  check('a non-array is rejected', notArray.status === 400, `got ${notArray.status}`)

  const fractional = await call('PATCH', '/admin/event', { lockedDays: [1.5] }, owner.cookie)
  check('a fractional day is rejected', fractional.status === 400, `got ${fractional.status}`)

  /* -- unlocking restores marking ---------------------------------------- */

  await setLocks([])
  await setOverride(1)
  const afterUnlock = await call('POST', '/admin/attendance', { sen: SEN_ALREADY }, owner.cookie)
  check(
    'reopening the day allows marking again',
    afterUnlock.status === 201,
    `${afterUnlock.status}/${afterUnlock.body?.code}`,
  )

  /* -- the whole set is replaced, not merged ----------------------------- */

  await call('PATCH', '/admin/event', { lockedDays: [1] }, owner.cookie)
  await call('PATCH', '/admin/event', { lockedDays: [2] }, owner.cookie)
  const both = await call('GET', '/event', undefined, owner.cookie)
  check(
    'setting a new set replaces the old one',
    Array.isArray(both.body?.lockedDays) &&
      both.body.lockedDays.length === 1 &&
      both.body.lockedDays[0] === 2,
    JSON.stringify(both.body?.lockedDays),
  )

  await cleanup()
  await db.end()
  report()
}

main().catch(async (error) => {
  console.error('\n  crashed:', error.message, '\n')
  try {
    await cleanup()
    if (db) await db.end()
  } catch {
    // The cleanup failure must not mask the real error.
  }
  process.exitCode = 1
})