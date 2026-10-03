#!/usr/bin/env node
/**
 * Samples PostgreSQL connection usage while a load test runs.
 *
 * The thing most likely to break under load here is not CPU — it is connection
 * exhaustion. Each warm serverless instance opens its own pool (`max: 5` in
 * `server/_lib/db.ts`), and those pools are per-instance and not shared. So the
 * real ceiling is `instances x 5` against the database's `max_connections`,
 * which nobody can predict from the code alone.
 *
 * If a run is about to exhaust the pool, it shows up here as a rising
 * `total` alongside `active` climbing and `idle` collapsing.
 *
 *   node scripts/connection-monitor.mjs --seconds 120
 */

import { Client } from 'pg'
import { loadEnv } from './_env.mjs'

loadEnv()

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(String(process.argv[i]).replace(/^--/, ''), process.argv[i + 1])
}

const SECONDS = Number(args.get('seconds') ?? 120)
const INTERVAL_MS = Number(args.get('interval') ?? 1000)

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const limits = await client.query(
  "select current_setting('max_connections')::int as max_conn",
)
const MAX = limits.rows[0].max_conn

console.log(`  monitoring connections for ${SECONDS}s (db max_connections=${MAX})`)

const started = Date.now()
const samples = []

while ((Date.now() - started) / 1000 < SECONDS) {
  try {
    const { rows } = await client.query(`
      select
        count(*)::int                                             as total,
        count(*) filter (where state = 'active')::int             as active,
        count(*) filter (where state = 'idle')::int               as idle,
        count(*) filter (where state = 'idle in transaction')::int as idle_in_txn,
        count(*) filter (where wait_event_type is not null)::int   as waiting
      from pg_stat_activity
      where datname = current_database()
    `)
    const r = rows[0]
    samples.push({ at: Math.round((Date.now() - started) / 1000), ...r })

    const pct = ((r.total / MAX) * 100).toFixed(1)
    const bar = '#'.repeat(Math.round((r.total / MAX) * 40))
    console.log(
      `  t+${String(samples.at(-1).at).padStart(3)}s  total=${String(r.total).padStart(4)}/${MAX} ` +
        `active=${String(r.active).padStart(3)} idle=${String(r.idle).padStart(4)} ` +
        `waiting=${String(r.waiting).padStart(3)}  ${pct.padStart(5)}%  ${bar}`,
    )
  } catch (error) {
    console.log(`  sample failed: ${error.message}`)
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
}

const peak = samples.reduce((a, b) => (b.total > a.total ? b : a), samples[0] ?? { total: 0 })
const peakActive = samples.reduce((a, b) => (b.active > a.active ? b : a), samples[0] ?? { active: 0 })

console.log('')
console.log(`  peak connections: ${peak.total} / ${MAX} (${((peak.total / MAX) * 100).toFixed(1)}%)`)
console.log(`  peak active:      ${peakActive.active}`)
console.log(`  samples taken:    ${samples.length}`)

await client.end()
