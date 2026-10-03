#!/usr/bin/env node
/**
 * Removes fixtures written by `npm run test:api`.
 *
 * The end-to-end suite deliberately exercises real registration and real scan
 * writes, so running it against the live database leaves rows behind. Those
 * rows would show up in the admin roster and attendance log — noise at an
 * event where every record is supposed to mean a real person.
 *
 * Scoped to the names the suite uses, never a blanket delete.
 *
 *   node scripts/clean-test-data.mjs
 */

import { Client } from 'pg'
import { loadEnv } from './_env.mjs'

loadEnv()

const url = process.env.DATABASE_URL
if (!url) {
  console.error('  DATABASE_URL is not set.')
  process.exit(1)
}

/**
 * Names used by the test suites.
 *
 * Scoped to exactly these on purpose. A blanket `delete from attendees` is how
 * a real registration gets destroyed by a test run — the suites create
 * attendees with recognisable names precisely so cleanup can tell them apart
 * from actual people. (It has already happened once during development.)
 */
const TEST_NAMES = [
  // scripts/test-api.mjs
  'Test Attendee',
  'Weak Pass',
  'Bad Phone',
  'Bad Sen',
  'Other Person',
  // scripts/test-gate-and-reset.mjs
  'Qr Tester',
  'Bare Tester',
]

/*
  Prefixes used by suites that register more than one attendee.

  Matched as prefixes rather than exact names so a suite can add rows without
  also having to register each one here — a fixture the cleanup script has never
  heard of is a fixture that shows up on the admin roster at the event.
*/
const TEST_PREFIXES = [
  'COPYPROBE%',
  'LOADTEST%',
]

/*
  The load test registers hundreds of attendees, so listing every name is not
  viable. It namespaces with a `LOADTEST` prefix on BOTH the name and the SEN,
  and this matches either — the phases label rows differently ("LOADTEST 12"
  and "LOADTEST S12").
*/
const LOADTEST_PATTERN = [...TEST_NAMES, ...TEST_PREFIXES]

const client = new Client({ connectionString: url })

try {
  await client.connect()

  // Attendance rows cascade from attendees, but delete them explicitly so this
  // stays correct if that FK is ever relaxed.
  const { rowCount: attendance } = await client.query(
    `delete from attendance
      where attendee_id in (
        select id from attendees
         where name like any($1) or sen like any($1)
      )`,
    [LOADTEST_PATTERN],
  )

  const { rowCount: attendees } = await client.query(
    'delete from attendees where name like any($1) or sen like any($1)',
    [LOADTEST_PATTERN],
  )

  const { rows } = await client.query(
    `select
       (select count(*) from attendees) as attendees,
       (select count(*) from attendance) as attendance,
       (select count(*) from teams)      as teams,       (select count(*) from agenda)     as agenda,
       (select count(*) from admins)     as admins`,
  )
  const live = rows[0]

  console.log(`  removed ${attendees} attendee(s), ${attendance} attendance row(s)`)
  console.log(
    `  remaining: attendees=${live.attendees} attendance=${live.attendance} ` +
      `teams=${live.teams} agenda=${live.agenda} admins=${live.admins}`,
  )
} catch (error) {
  console.error('  cleanup failed:', error.message)
  process.exitCode = 1
} finally {
  await client.end()
}
