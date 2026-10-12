#!/usr/bin/env node
/**
 * Puts the EVENT back to its neutral state.
 *
 * Separate from `clean-test-data.mjs`, which removes fixture ATTENDEES. This one
 * clears the operational debris a hard-killed suite leaves behind, and it exists
 * because an interrupted run used to leave `day_override = 2` and
 * `registration_mode = 'restricted'` set, with the symptom downstream being a
 * wall of 422s from registration that all read `not_on_list` — which points at
 * the guest list rather than at the run that was interrupted.
 *
 * WHAT IT WILL NOT TOUCH, because these are the organiser's decisions and not a
 * test's debris: the guest list, and the registration mode unless `--reset-mode`
 * is passed. Forcing `open` on a `restricted` event, or emptying a roster, is the
 * same failure as the bug this script was written to fix — in the opposite
 * direction, and much harder to undo.
 *
 * Restore the day FIRST and unconditionally. A stale attendee is one row; a stale
 * day pin misfiles a whole morning's attendance.
 */

import { Client } from 'pg'
import { loadEnv } from './_env.mjs'

loadEnv()

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const before = await db.query(
  `select day_override, locked_days, registration_mode, roster_uploaded_at
     from events where id = 'evt_awakening_2026'`,
)
console.log(
  `  before: day_override=${before.rows[0].day_override} ` +
    `locked_days=${JSON.stringify(before.rows[0].locked_days)} ` +
    `mode=${before.rows[0].registration_mode}`,
)

/* Day first. Unconditionally, and on its own, so it cannot be skipped by a later
   statement throwing. */
await db.query(
  `update events set day_override = null where id = 'evt_awakening_2026'`,
)

/*
  Registration mode is NOT reset by default.

  It used to be forced to `open` here, along with `roster_uploaded_at = null` and
  a `delete from event_roster`. All three are decisions the ORGANISER makes, not
  debris a test leaves behind, and a script whose job is undoing a crashed test
  run cannot tell the difference between "a suite left this set" and "somebody set
  this deliberately at 9am".

  Forcing `open` on a `restricted` event is the same class of damage as deleting
  the list: everybody the organiser meant to turn away walks in.

  A killed run can still leave `restricted` behind — that was this script's
  original reason to exist — so `--reset-mode` restores the old behaviour, but it
  has to be asked for by name.
*/
const resetMode = process.argv.includes('--reset-mode')

const modeBefore = await db.query(
  `select registration_mode, roster_uploaded_at from events where id = 'evt_awakening_2026'`,
)

await db.query(
  `update events set locked_days = '{}'::smallint[] where id = 'evt_awakening_2026'`,
)

if (resetMode) {
  await db.query(
    `update events
        set registration_mode = 'open', roster_uploaded_at = null
      where id = 'evt_awakening_2026'`,
  )
  console.log(`  registration mode reset: ${modeBefore.rows[0].registration_mode} -> open`)
} else {
  console.log(
    `  registration mode left alone: ${modeBefore.rows[0].registration_mode}` +
      ` (pass --reset-mode to force it open)`,
  )
}

/*
  The guest list is never cleared here.

  It used to be, and that is how a real uploaded list of students' names and SENs
  was destroyed: this script exists to undo the damage of a killed test run, and
  the one thing it must never do is add more. There is no backup of the roster and
  no audit table to recover it from.

  A suite that armed `RosterGuard` writes its snapshot to disk before clearing, so
  the correct recovery is to run `restore-roster.mjs` against that file.
*/
const rosterNow = await db.query('select count(*)::int as n from event_roster')
if (rosterNow.rows[0].n > 0) {
  console.log(`  guest list left untouched: ${rosterNow.rows[0].n} row(s)`)
} else {
  console.log(
    '  guest list is empty. If a suite cleared it, restore it from its snapshot:\n' +
      '      node scripts/restore-roster.mjs --latest',
  )
}

const leaked = await db.query(
  "select count(*)::int as n from attendees where upper(sen) like 'ZTEST%'",
)
console.log(`  ZTEST fixture attendees still present: ${leaked.rows[0].n}`)

const after = await db.query(
  `select day_override, locked_days, registration_mode
     from events where id = 'evt_awakening_2026'`,
)
console.log(
  `  after:  day_override=${after.rows[0].day_override} ` +
    `locked_days=${JSON.stringify(after.rows[0].locked_days)} ` +
    `mode=${after.rows[0].registration_mode}`,
)

await db.end()