/**
 * Shared test-fixture helpers: how every suite names its fixtures, and how they
 * clean up after themselves.
 *
 * WHY THIS EXISTS
 *
 * The live suites register real attendees against the production database, because
 * the registration endpoint is the thing under test. Every one of those
 * registrations leaves a row behind, and an attendee row is indistinguishable from a
 * real one: it appears on the owner's roster, in the attendance log, and in the SEN
 * export. Five fixtures had accumulated by the time this was noticed, four of them
 * carrying attendance marks — so the live log showed ten people on day one when
 * five had actually turned up.
 *
 * That is not a cosmetic problem. The SEN export is the artefact the event hands
 * to whoever issues certificates, and junk in it is junk handed on.
 *
 * `test:perday` fixed this for itself by deleting on a `PDAY%` prefix. Doing it
 * once per suite is how it came back three times, so the convention lives here and
 * every suite uses it.
 *
 * THE RULE
 *
 *   1. Every fixture SEN is built with `testSen(tag)`, so it starts with ZTEST.
 *   2. Every suite calls `purgeTestAttendees` when it finishes — on success AND on
 *      a crash, because a suite that throws halfway is exactly the one that needs
 *      to clean up.
 *
 * On the prefix: `Z` is not an Amity SEN letter and the digits are all zeroes, so a
 * fixture cannot be mistaken for a registration in a screenshot or a log line. The
 * SEN validator is deliberately permissive (4+ alphanumerics, at least one digit),
 * so this passes validation and still cannot collide with real data.
 */

import { loadEnv } from './_env.mjs'

/** Marks every attendee a test suite creates. */
export const TEST_SEN_PREFIX = 'ZTEST'

/**
 * Prefixes that predate the convention, still swept so old runs do not linger.
 *
 * `test:perday` used `PDAY…` and cleaned up after itself, but only from the run
 * that created a fixture — fixtures from an interrupted run stayed on the live
 * roster indefinitely. Keeping the prefix in the sweep means the next test run
 * mops them up.
 *
 * `NONE` is a time bomb: any attendee who registers without an SEN is stored as
 * `NONE`, so it is NOT a test prefix and is deliberately absent here.
 */
const LEGACY_TEST_PREFIXES = ['PDAY%']

/** A fixture SEN that no real registration could collide with. */
export function testSen(tag) {
  return `${TEST_SEN_PREFIX}${tag}`
}

/**
 * Deletes every attendee created by a test suite, by prefix.
 *
 * Scoped by PREFIX rather than by this run's SEN, deliberately. Deleting only what
 * the current run made leaves the previous run's fixtures behind forever, so a
 * crashed or interrupted suite is still cleaned up by the next one. That exact
 * mistake is what let stale attendees accumulate on the live roster.
 *
 * Attendance and sessions go with it by cascade — the schema declares
 * `attendee_id ... on delete cascade` on both — so no orphan marks are left
 * behind. `password_changes` is deleted explicitly, because an admin resetting a
 * fixture attendee's password must not leave the fixture's history behind either.
 *
 * @param client a connected `pg` client
 * @returns how many attendees were removed
 */
export async function purgeTestAttendees(client) {
  if (!client) return 0

  const prefixes = [`${TEST_SEN_PREFIX}%`, ...LEGACY_TEST_PREFIXES]

  const { rows } = await client.query(
    'select id from attendees where upper(sen) like any($1::text[])',
    [prefixes],
  )
  if (rows.length === 0) return 0

  const ids = rows.map((row) => row.id)

  // Session rows are keyed by subject_id with a kind discriminator; attendance and
  // password_changes cascade from the attendee. Deleting in this order keeps the
  // audit trail consistent even if the cascade were ever dropped.
  for (const id of ids) {
    await client.query('delete from sessions where subject_id = $1', [id])
    await client.query('delete from password_changes where attendee_id = $1', [id])
  }
  await client.query('delete from attendees where id = any($1::uuid[])', [ids])

  return ids.length
}

/**
 * Connects, purges, and disconnects — for suites that do not otherwise hold a
 * database connection open.
 *
 * A no-op returning 0 when `DATABASE_URL` is unset, because a local run against
 * `vite` has no database to talk to and that is an environment fact rather than a
 * failure. Same reasoning as `auditRowsFor` in the gate suite.
 */
export async function purgeTestAttendeesOnce() {
  /*
    Read `.env` from the PROJECT ROOT, not from beside this file. Two suites are
    esbuild-bundled into `node_modules/.tmp/` before running, so this file's own
    location no longer reflects the repository. npm always runs scripts from the
    root, which makes `process.cwd()` the reliable answer for all of them.
  */
  loadEnv(process.cwd())

  const url = process.env.DATABASE_URL
  if (!url) return 0

  const { Client } = await import('pg')
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  try {
    await client.connect()
    return await purgeTestAttendees(client)
  } finally {
    await client.end()
  }
}