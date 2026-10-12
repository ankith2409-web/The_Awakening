#!/usr/bin/env node
/**
 * The guest list must survive a test run.
 *
 * This exists because it did not. A real uploaded guest list — every student's
 * name and SEN — was destroyed by a suite that cleared the roster and failed to
 * put it back. There is no backup of the roster and no audit table, so the data
 * was simply gone, and the only evidence it had existed was a
 * `roster_uploaded_at` timestamp pointing at an empty table.
 *
 * The suites it destroyed it could not tell whether they were about to. So this
 * suite asserts the GUARD's behaviour directly, against the live database:
 *
 *   1. It refuses to clear a non-empty list without an explicit override.
 *   2. It writes a snapshot to DISK before touching anything.
 *   3. It restores exactly, and verifies rather than assuming.
 *   4. It still arms when the list is already empty — otherwise a suite that
 *      uploads rows through the API would never clean them up.
 *
 * Plus static assertions that no script can clear the roster without the guard.
 *
 * Needs DATABASE_URL. Runs against whatever DATABASE_URL points at, so it uses
 * fixture SENs that are unmistakable and removes only those.
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Client } from 'pg'
import { loadEnv } from './_env.mjs'
import { tally } from './_source.mjs'
import { RosterGuard } from './_roster-guard.mjs'

loadEnv()

const { check, report } = tally()

/* Unmistakable fixtures, removed by their exact SENs. Never a pattern. */
const FIXTURES = ['ZGUARD0000001', 'ZGUARD0000002', 'ZGUARD0000003']
const FIXTURE_ROWS = FIXTURES.map((sen, i) => ({ sen, name: `Fixture ${i + 1}` }))

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

async function setRoster(rows) {
  await db.query('begin')
  await db.query('delete from event_roster')
  if (rows.length > 0) {
    await db.query(
      `insert into event_roster (sen, name) select * from unnest($1::text[], $2::text[])`,
      [rows.map((r) => r.sen), rows.map((r) => r.name)],
    )
  }
  await db.query('commit')
}

const current = async () => (await db.query('select sen, name from event_roster order by sen')).rows

async function main() {
  console.log('\n  Guest list safety\n')

  await db.connect()

  const realBefore = await current()
  check(
    'the live guest list was empty when this started, so these are all fixtures',
    realBefore.every((r) => r.sen.startsWith('ZGUARD')),
    `found ${JSON.stringify(realBefore.slice(0, 4))}`,
  )

  /* -- 1. it refuses ------------------------------------------------------- */

  delete process.env.ALLOW_ROSTER_RESET
  await setRoster(FIXTURE_ROWS)

  let guard = new RosterGuard(db, 'test:demo')
  let refusal = null
  try {
    await guard.arm()
  } catch (error) {
    refusal = error
  }

  check('refuses to clear a list that has rows in it', refusal !== null)
  check(
    'the refusal says how many rows are at stake',
    refusal !== null && refusal.message.includes('3 row(s)'),
  )
  check(
    'the refusal says how to override it',
    refusal !== null && refusal.message.includes('ALLOW_ROSTER_RESET'),
  )
  check('and the list is untouched after a refusal', (await current()).length === 3)

  /* -- 2. snapshot, clear, restore, verify --------------------------------- */

  process.env.ALLOW_ROSTER_RESET = '1'
  guard = new RosterGuard(db, 'test:demo')
  await guard.arm()

  check('armed: the list is empty', (await current()).length === 0)
  check('a snapshot path was produced', typeof guard.snapshotPath === 'string')

  let onDisk = null
  try {
    onDisk = JSON.parse(await readFile(guard.snapshotPath, 'utf8'))
  } catch (error) {
    check('the snapshot is readable from disk', false, error.message)
  }
  check(
    'the snapshot on disk holds every row',
    onDisk !== null && onDisk.rows.length === 3,
    onDisk ? `${onDisk.rows.length} rows` : 'unreadable',
  )
  check(
    'and it is on disk rather than only in memory',
    /*
      A snapshot held in a variable dies with the process, which was one of the
      four ways the list was lost. This is the one fix that survives a hard kill.
    */
    typeof guard.snapshotPath === 'string' && guard.snapshotPath.includes('the-awakening-roster'),
  )

  /* What a suite actually does while it runs. */
  await db.query(
    `insert into event_roster (sen, name) values ('A866175000999', 'Junk From A Suite')`,
  )
  check('the suite left a row behind', (await current()).length === 1)

  await guard.restore()
  const restored = await current()

  check('restore brought the list back', restored.length === 3, `got ${restored.length}`)
  check(
    'every row is byte-for-byte what it was',
    JSON.stringify(restored) === JSON.stringify(FIXTURE_ROWS),
  )

  /* -- 3. restore is safe to repeat ---------------------------------------- */

  await guard.restore()
  check('a second restore does not double the list', (await current()).length === 3)

  /* -- 4. the empty-list case, which is where this nearly regressed --------- */

  await setRoster([])
  guard = new RosterGuard(db, 'test:demo')
  await guard.arm()
  check('it arms even when the list is already empty', (await current()).length === 0)

  await db.query(`insert into event_roster (sen, name) values ('A866175000998', 'Leftover')`)
  check('a suite left a row behind on an empty list', (await current()).length === 1)

  await guard.restore()
  check(
    'and restore cleans it up instead of no-oping',
    (await current()).length === 0,
    'an early return on an empty list turns the guard into a no-op exactly when it is needed',
  )

  /* -- 5. nothing else can clear the roster ------------------------------- */

  const scripts = [
    'scripts/test-guest-list.mjs',
    'scripts/test-registration.mjs',
    'scripts/test-hardening.mjs',
    'scripts/reset-event-state.mjs',
    'scripts/_roster-guard.mjs',
  ]

  for (const path of scripts) {
    const text = readFileSync(path, 'utf8')
    const statements = text
      .split('\n')
      .filter((line) => /^\s*(await\s+\w+\.)?query\(\s*['"`]delete from event_roster/.test(line))

    check(
      `${path} clears the roster only through the guard`,
      statements.length === 0 || path === 'scripts/_roster-guard.mjs',
      `${statements.length} raw delete(s): ${statements.join(' | ')}`,
    )
  }

  /*
    The upload route must replace the list inside ONE transaction.

    Checked structurally rather than with a character window. An earlier version
    of this assertion used `begin[\s\S]{0,400}delete...commit`, which is the same
    fragile idea as every other window in this codebase: it passes until someone
    adds a four-line comment above the commit, and then fails on correct code. So:
    take the transaction block and look at what is actually inside it.
  */
  const routeSource = readFileSync('server/[...route].ts', 'utf8')

  /*
    Anchor on the `delete`, then walk outward to the enclosing transaction.

    Anchoring on the insert — which is what a first attempt did — starts the
    search AFTER the `begin` and the `delete`, so the block it finds can never
    contain either. The statement that identifies the transaction is the delete.
  */
  const deleteAt = routeSource.indexOf("query('delete from event_roster')")
  const beginAt = routeSource.lastIndexOf("query('begin')", deleteAt)
  const commitAt = routeSource.indexOf("query('commit')", deleteAt)
  const rollbackAt = routeSource.indexOf("query('rollback')", commitAt)

  const txBlock =
    deleteAt === -1 || beginAt === -1 || commitAt === -1
      ? ''
      : routeSource.slice(beginAt, commitAt)

  check(
    'the upload route deletes and inserts inside one transaction',
    beginAt !== -1 &&
      deleteAt > beginAt &&
      commitAt > deleteAt &&
      txBlock.includes('insert into event_roster') &&
      !txBlock.slice(txBlock.indexOf("query('begin')") + 1).includes("query('begin')"),
    'a delete and an insert in separate transactions lose the list if the insert fails',
  )

  check(
    'and it rolls back rather than leaving a half-written list',
    rollbackAt !== -1 && rollbackAt > commitAt,
  )

  check(
    'reset-event-state no longer clears the list or forces the mode',
    !/query\(\s*['"`]delete from event_roster/.test(readFileSync('scripts/reset-event-state.mjs', 'utf8')),
  )

  check(
    'a recovery script exists for when the guard itself fails',
    readFileSync('scripts/restore-roster.mjs', 'utf8').includes('event_roster'),
  )
}

main()
  .catch((error) => {
    console.error('\n  crashed:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    // Scoped to the fixtures this suite created, never a blanket delete.
    try {
      await db.query("delete from event_roster where sen = any($1::text[])", [FIXTURES])
      await db.query("delete from event_roster where sen = any($1::text[])", [
        'A866175000999',
        'A866175000998',
      ])
    } catch {
      console.error('  (fixture rows could not be removed — remove them by hand)')
    }
    await db.end().catch(() => {})
    report()
  })