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

  /*
    Sessions FIRST, and for a specific reason.

    `sessions.subject_id` has no foreign key — one column serves both attendee
    and admin sessions — so deleting an attendee does NOT take its sessions with
    it. Deleting only the attendee rows leaves a live session pointing at an
    account that no longer exists.

    It is not a security hole: `GET /attendee/session` resolves the subject and
    returns `null` when it is gone, so the holder is treated as anonymous. But
    the rows are never cleaned up, because the cold-start purge only removes
    sessions that have EXPIRED, and a test session's lifetime has not run out.
    Every run against the live database therefore leaks a few more, and they
    accumulate indefinitely.

    Fifty-four of them had built up before this was fixed.
  */
  const { rowCount: sessions } = await client.query(
    `delete from sessions
      where kind = 'attendee'
        and subject_id in (
          select id from attendees
           where name like any($1) or sen like any($1)
        )`,
    [LOADTEST_PATTERN],
  )

  // Attendance rows cascade from attendees, but delete them explicitly so this
  // stays correct if that FK is ever relaxed — as the comment above already
  // required for sessions.
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
       (select count(*) from teams)      as teams,
       (select count(*) from agenda)     as agenda,
       (select count(*) from admins)     as admins,
       -- Sessions pointing at an account that no longer exists. Must stay 0:
       -- see the note above on why these are not cleaned up automatically.
       (select count(*) from sessions s
         where s.kind = 'attendee'
           and not exists (select 1 from attendees a where a.id = s.subject_id)) as orphan_sessions`,
  )
  const live = rows[0]

  console.log(
    `  removed ${attendees} attendee(s), ${attendance} attendance row(s), ` +
      `${sessions} session(s)`,
  )
  console.log(
    `  remaining: attendees=${live.attendees} attendance=${live.attendance} ` +
      `teams=${live.teams} agenda=${live.agenda} admins=${live.admins} ` +
      `orphan_sessions=${live.orphan_sessions}`,
  )

  if (Number(live.orphan_sessions) > 0) {
    console.log(
      '  WARNING: orphaned sessions remain. They resolve to "anonymous" and are ' +
        'harmless, but nothing else removes them until they expire.',
    )
  }
} catch (error) {
  console.error('  cleanup failed:', error.message)
  process.exitCode = 1
} finally {
  await client.end()
}
