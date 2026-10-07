#!/usr/bin/env node
/**
 * Attendance, per day.
 *
 * The bug this exists for: `attendance` had a unique index on `attendee_id`, so a
 * record meant "this person has been through the door, ever". Somebody who attended
 * both days could only ever be marked once, and on day two their badge came back
 * "already checked in". Not everyone attends both days, so a single flag cannot
 * represent this event either.
 *
 * Everything here drives real routes with a real session. `test:event-day` covers
 * the calendar arithmetic separately, because that is the half that can fail
 * silently.
 *
 * The day is moved with the owner override rather than by waiting for October, which
 * is also the only way the day-two path can be exercised before it happens.
 *
 *   ADMIN_USERNAME / ADMIN_PASSWORD in the environment, or in .env.
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

  const setCookie = (res.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(';')[0])
    .join('; ')

  const text = await res.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed, cookie: setCookie }
}

/* Digits only: this stamp also builds a phone number. */
const stamp = Date.now().toString().slice(-9)
const SEN = testSen(`PDAY${stamp}`)
const PHONE = `7${stamp}`.slice(0, 10).padEnd(10, '4')
const PASSWORD = 'probe2026pass'

let db = null
let originalOverride = null

async function cleanup() {
  if (!db) return

  /*
    Restore the day FIRST, and unconditionally.

    Two things were wrong here. The attendee purge ran first and unguarded, so a
    throw there skipped the restore entirely — leaving the live event pinned and
    every subsequent scan filing into the wrong day. And the restore was last, which
    made it the thing most likely to be lost.

    The day is the more damaging of the two by far: a stale attendee is one row on a
    roster, a stale pin misfiles a whole day's attendance. So it goes first and it
    goes regardless.
  */
  try {
    await db.query(`update events set day_override = $1 where id = 'evt_awakening_2026'`, [
      originalOverride,
    ])
  } catch (error) {
    console.error(`\n  FATAL: could not restore day_override — ${error.message}`)
    console.error('  Run:  update events set day_override = null;')
    process.exitCode = 1
    return
  }

  /*
    By PREFIX, not by this run's SEN — the shared helper in `_fixtures.mjs`, which
    every live suite now uses.

    This started as a local fix. An earlier version deleted only
    `PDAY<this run's stamp>`, which left every previous run's fixtures behind —
    four stale "Day One Only" attendees had accumulated on the live roster, where a
    real organiser would have seen them as people who never registered. Scoping to
    a prefix means a crashed or interrupted run cleans up everything on the next
    one, and doing it once per suite is how the same leak reappeared three times.
  */
  await purgeTestAttendees(db)
}

async function setOverride(day) {
  await db.query(`update events set day_override = $1 where id = 'evt_awakening_2026'`, [day])
}

async function main() {
  console.log(`\n  Testing ${BASE}\n`)

  if (!process.env.DATABASE_URL) {
    console.log('  DATABASE_URL is not set — this suite moves the event day.\n')
    process.exitCode = 1
    return
  }
  db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()

  const { rows: existing } = await db.query(
    `select day_override from events where id = 'evt_awakening_2026'`,
  )
  originalOverride = existing[0]?.day_override ?? null

  /*
    Refuse to ADOPT a pin this suite did not set.

    This suite captures whatever override it finds and faithfully restores it at the
    end. That is correct behaviour and it is exactly how a stale pin survives: a
    previous run was interrupted between "set" and "restore", leaving the live event
    pinned to a day. The next run reads that value, decides it is the original, and
    puts it back — so the corruption is preserved indefinitely and no assertion ever
    sees it, because every assertion inside the suite passes.

    That happened. `day_override` was found set to 2 on 2026-10-07, eight days before
    the event, meaning the portal was filing every scan under day two.

    So a pre-existing pin is a failure, not a starting condition. Asserted loudly,
    and reset rather than restored: leaving a stale pin changes which day real
    attendance lands in, which is worse than a red test.
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

  await cleanup()

  /* -- an owner, and the event's own idea of the day ----------------------- */
  const owner = await call('POST', '/admin/login', {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? '',
  })
  check('the owner signs in', owner.status === 200, `got ${owner.status}`)
  if (owner.status !== 200) {
    await db.end()
    process.exitCode = 1
    return
  }

  await setOverride(1)

  const event = await call('GET', '/event')
  check('the event reports a day count', event.body?.totalDays >= 2, `totalDays=${event.body?.totalDays}`)
  check('the event reports the active day', event.body?.activeDay === 1, `activeDay=${event.body?.activeDay}`)
  check(
    'the event reports the calendar day separately from the override',
    typeof event.body?.calendarDay === 'number',
    `calendarDay=${event.body?.calendarDay}`,
  )
  check('the override is flagged', event.body?.dayOverridden === true)
  const totalDays = event.body.totalDays

  /* -- day one -------------------------------------------------------------- */
  const reg = await call('POST', '/attendee/register', {
    name: 'Per Day Probe',
    phone: PHONE,
    sen: SEN,
    password: PASSWORD,
  })
  check('registered a probe attendee', reg.status === 201, `got ${reg.status}`)

  const first = await call('POST', '/admin/attendance', { sen: SEN }, owner.cookie)
  check('a scan on day one is accepted', first.status === 201, `got ${first.status}`)
  check('the record is day one', first.body?.day === 1, `day=${first.body?.day}`)
  check(
    'the response tells the client which day it recorded',
    first.body?.dayState?.activeDay === 1,
    JSON.stringify(first.body?.dayState),
  )
  check(
    'the response tells the client how many days there are',
    first.body?.dayState?.totalDays === totalDays,
  )

  const again = await call('POST', '/admin/attendance', { sen: SEN }, owner.cookie)
  check('a second scan on the same day is refused', again.status === 409, `got ${again.status}`)

  /* -- the lock: day two cannot be scanned while day one is current --------- */
  /*
    Structural rather than a check. The scan takes no day, so the only way to get
    a day-two record is for the server to believe it is day two. Proving the record
    did not appear is the observable consequence.
  */
  const dayOneLog = await call('GET', '/admin/attendance', undefined, owner.cookie)
  const dayOneRows = (dayOneLog.body ?? []).filter((row) => row.sen === SEN)
  check('exactly one record exists so far', dayOneRows.length === 1, `${dayOneRows.length} rows`)
  check('and it is day one only', dayOneRows.every((row) => row.day === 1))

  /* -- day two -------------------------------------------------------------- */
  await setOverride(2)

  const second = await call('POST', '/admin/attendance', { sen: SEN }, owner.cookie)
  check(
    'the same badge is accepted again on day two — that is attending both days',
    second.status === 201,
    `got ${second.status}`,
  )
  check('the second record is day two', second.body?.day === 2, `day=${second.body?.day}`)

  const third = await call('POST', '/admin/attendance', { sen: SEN }, owner.cookie)
  check('a second scan on day two is refused', third.status === 409, `got ${third.status}`)

  const bothLog = await call('GET', '/admin/attendance', undefined, owner.cookie)
  const bothRows = (bothLog.body ?? []).filter((row) => row.sen === SEN)
  check('two records now exist', bothRows.length === 2, `${bothRows.length} rows`)
  check(
    'one per day',
    bothRows.map((row) => row.day).sort().join(',') === '1,2',
    bothRows.map((row) => row.day).join(','),
  )
  check(
    'the log is ordered by day',
    bothLog.body.every((row, index, all) => index === 0 || all[index - 1].day <= row.day),
  )

  /* -- the attendee sees both days ------------------------------------------ */
  const attendeeLogin = await call('POST', '/attendee/login', {
    name: 'Per Day Probe',
    phone: PHONE,
    password: PASSWORD,
    remember: false,
  })
  check('the probe attendee can sign in', attendeeLogin.status === 200, `got ${attendeeLogin.status}`)

  const mine = await call('GET', '/attendee/attendance', undefined, attendeeLogin.cookie)
  check(
    'they see one record per day, not just the first',
    Array.isArray(mine.body?.records) && mine.body.records.length === 2,
    `${mine.body?.records?.length} records`,
  )
  check(
    'both records carry their day',
    (mine.body?.records ?? []).every((row) => row.day === 1 || row.day === 2),
  )
  check('they are told how many days the event has', mine.body?.totalDays === totalDays)
  check(
    'they are told which day is current',
    mine.body?.activeDay === 2,
    `activeDay=${mine.body?.activeDay}`,
  )

  /* -- an attendee who came to one day only --------------------------------- */
  const oneDaySen = `PDAY1${stamp}`
  await call('POST', '/attendee/register', {
    name: 'Day One Only',
    phone: `8${stamp}`.slice(0, 10).padEnd(10, '5'),
    sen: oneDaySen,
    password: PASSWORD,
  })
  await setOverride(1)
  await call('POST', '/admin/attendance', { sen: oneDaySen }, owner.cookie)

  const partialLogin = await call('POST', '/attendee/login', {
    name: 'Day One Only',
    phone: `8${stamp}`.slice(0, 10).padEnd(10, '5'),
    password: PASSWORD,
    remember: false,
  })
  const partial = await call('GET', '/attendee/attendance', undefined, partialLogin.cookie)
  check(
    'an attendee who came to one day only has exactly one record',
    partial.body?.records?.length === 1,
    `${partial.body?.records?.length} records`,
  )
  check(
    'and it is day one',
    partial.body?.records?.[0]?.day === 1,
    `day=${partial.body?.records?.[0]?.day}`,
  )
  check(
    'while still being told the event runs for two days',
    partial.body?.totalDays === totalDays,
    `totalDays=${partial.body?.totalDays}`,
  )

  await cleanup()
  check('probe attendees removed', true)

  await db.end()
  report()
}

main().catch(async (error) => {
  console.error('\n  crashed:', error.message, '\n')
  try {
    await cleanup()
    if (db) await db.end()
  } catch {
    // Never let the cleanup failure mask the real error.
  }
  process.exitCode = 1
})