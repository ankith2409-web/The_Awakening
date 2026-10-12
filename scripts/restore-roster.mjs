#!/usr/bin/env node
/**
 * Put a guest-list snapshot back, by hand.
 *
 * This exists because the guard that takes the snapshot can itself be the thing
 * that fails. Every error message the guard prints ends by pointing here, because
 * "the suite crashed and so did the automatic restore" must never be the end of
 * the story when a file on disk holds every student's name and SEN.
 *
 *     node scripts/restore-roster.mjs "<path to snapshot json>"
 *     node scripts/restore-roster.mjs --latest
 *
 * Safe to run twice. It replaces the list wholesale inside one transaction, so a
 * second run restores the same snapshot rather than doubling it, and a failure
 * partway through leaves whatever was there untouched.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from 'pg'
import { loadEnv } from './_env.mjs'

loadEnv()

const SNAPSHOT_DIR = join(tmpdir(), 'the-awakening-roster')

function fail(message) {
  console.error(`\n  ${message}\n`)
  process.exit(1)
}

async function main() {
  const arg = process.argv[2]

  if (!arg) {
    const available = listSnapshots()
    fail(
      [
        'Usage: node scripts/restore-roster.mjs "<snapshot.json>"',
        '       node scripts/restore-roster.mjs --latest',
        available.length > 0
          ? `\nSnapshots on disk:\n${available.map((p) => `    ${p}`).join('\n')}`
          : `\nNo snapshots found in ${SNAPSHOT_DIR}`,
      ].join('\n'),
    )
  }

  const path = arg === '--latest' ? listSnapshots().at(-1) : arg

  if (!path) fail('No snapshot to restore.')
  if (arg === '--latest' && path === undefined) fail(`No snapshots found in ${SNAPSHOT_DIR}`)

  let snapshot
  try {
    snapshot = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`Could not read ${path}: ${error.message}`)
  }

  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : []
  console.log(`\n  Restoring ${rows.length} guest-list row(s)`)
  console.log(`  from ${path}`)
  console.log(`  saved at ${snapshot.savedAt}`)

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })

  try {
    await client.connect()

    const current = await client.query('select count(*)::int as n from event_roster')
    console.log(`\n  The list currently holds ${current.rows[0].n} row(s). This REPLACES it.`)

    await client.query('begin')
    await client.query('delete from event_roster')

    if (rows.length > 0) {
      await client.query(
        `insert into event_roster (sen, name) select * from unnest($1::text[], $2::text[])`,
        [rows.map((r) => r.sen), rows.map((r) => r.name)],
      )
    }

    // Only restore the mode when the snapshot recorded one; an empty snapshot may
    // legitimately have none, and inventing `open` here would quietly change who
    // may register.
    if (typeof snapshot.mode === 'string') {
      await client.query(
        `update events set registration_mode = $1, roster_uploaded_at = $2
          where id = 'evt_awakening_2026'`,
        [snapshot.mode, snapshot.uploadedAt ?? null],
      )
    }

    await client.query('commit')

    const after = await client.query('select sen, name from event_roster order by sen')
    /*
      Compared field by field.

      A space separator would be ambiguous: a name may contain a space, so
      ("A B", "C") and ("A", "B C") would compare equal — and this is the check
      somebody reads to decide whether their guest list came back.
    */
    const got = after.rows
    const want = rows
    const exact =
      got.length === want.length &&
      got.every((row, i) => row.sen === want[i].sen && row.name === want[i].name)

    console.log(`\n  ${exact ? 'Restored and verified' : 'RESTORED BUT MISMATCHED'}: ${got.length} row(s)`)
    if (!exact) {
      console.error('  The rows on disk do not match the snapshot. Do not trust this.')
      process.exitCode = 1
    }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    fail(`Restore failed and was rolled back: ${error.message}`)
  } finally {
    await client.end().catch(() => {})
  }
}

function listSnapshots() {
  try {
    return readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => join(SNAPSHOT_DIR, f))
  } catch {
    return []
  }
}

main().catch((error) => fail(error.message))