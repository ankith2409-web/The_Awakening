#!/usr/bin/env node
/**
 * Puts the EVENT back to its neutral state.
 *
 * Separate from `clean-test-data.mjs`, which removes fixture ATTENDEES. This one
 * clears the operational switches, and it exists because a suite killed hard enough
 * that its own restore never ran leaves the live event in a state that quietly breaks
 * every other suite.
 *
 * It did exactly that: an interrupted run left `day_override = 2` and
 * `registration_mode = 'restricted'`, and the symptom downstream was a wall of 422s
 * from registration that all read `not_on_list` — which points at the guest list
 * rather than at the run that was interrupted.
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

await db.query(
  `update events
      set locked_days = '{}'::smallint[],
          registration_mode = 'open',
          roster_uploaded_at = null
    where id = 'evt_awakening_2026'`,
)

const roster = await db.query('delete from event_roster')
console.log(`  cleared ${roster.rowCount} guest-list rows`)

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