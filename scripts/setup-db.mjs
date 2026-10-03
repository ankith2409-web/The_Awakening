#!/usr/bin/env node
/**
 * One-command database setup.
 *
 *   npm run db:setup
 *
 * Reads DATABASE_URL, applies db/schema.sql then db/seed.sql, and creates the
 * first admin from ADMIN_USERNAME / ADMIN_PASSWORD if the admins table is
 * empty. Everything is idempotent, so it is safe to re-run.
 *
 * Requires no psql, no migration tool, and no local Postgres.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { loadEnv } from './_env.mjs'

loadEnv()

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  console.error('\n  DATABASE_URL is not set.\n')
  console.error('  Either put it in .env (see .env.example), or set it inline:')
  console.error('    $env:DATABASE_URL="postgresql://..."   # PowerShell')
  console.error('    export DATABASE_URL="postgresql://..."   # macOS/Linux\n')
  process.exit(1)
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  // Neon may suspend an idle branch on first connect.
  connectionTimeoutMillis: 20_000,
})

async function apply(file) {
  const sql = readFileSync(join(root, 'db', file), 'utf8')
  await client.query(sql)
  console.log(`  applied db/${file}`)
}

async function seedAdmin() {
  const username = process.env.ADMIN_USERNAME
  const password = process.env.ADMIN_PASSWORD
  const displayName = process.env.ADMIN_DISPLAY_NAME ?? 'Event Operations'

  if (!username || !password) {
    console.log(
      '\n  No ADMIN_USERNAME / ADMIN_PASSWORD set — skipping admin creation.\n' +
        '  The admin portal will refuse to sign in until one exists.\n',
    )
    return
  }

  if (password.length < 8) {
    console.error('  ADMIN_PASSWORD must be at least 8 characters.')
    process.exit(1)
  }

  const existing = await client.query('select 1 from admins limit 1')
  if (existing.rowCount && existing.rowCount > 0) {
    console.log('  an admin already exists — leaving it alone')
    return
  }

  const hash = await bcrypt.hash(password, 10)
  await client.query(
    'insert into admins (username, display_name, password_hash) values ($1, $2, $3)',
    [username, displayName, hash],
  )
  console.log(`  created admin "${username}"`)
}

try {
  console.log('\n  Connecting to Neon…')
  await client.connect()
  console.log('  connected\n')

  await apply('schema.sql')
  await apply('seed.sql')
  await seedAdmin()

  const counts = await client.query(
    `select
       (select count(*) from events)   as events,
       (select count(*) from agenda)   as agenda,
       (select count(*) from teams)    as teams,
       (select count(*) from admins)   as admins,
       (select count(*) from attendees) as attendees`,
  )
  const row = counts.rows[0]
  console.log(
    `\n  Done. events=${row.events} agenda=${row.agenda} teams=${row.teams} ` +
      `admins=${row.admins} attendees=${row.attendees}\n`,
  )
} catch (error) {
  console.error('\n  Setup failed:', error.message, '\n')
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}