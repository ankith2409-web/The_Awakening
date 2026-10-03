/**
 * Where does the latency actually go?
 *
 * The load test showed ~2.2s for a register at concurrency 4, which is far more
 * than the bcrypt hash costs (60ms). This isolates each layer so the cause is
 * identified rather than guessed at:
 *
 *   - a single-query endpoint (baseline HTTP + one Neon round trip)
 *   - a three-query endpoint (adds per-query cost)
 *   - a bcrypt path (adds hashing)
 *   - pg from this machine (raw database round trip, no HTTP)
 *
 *   node scripts/latency-breakdown.mjs
 */

import { Client } from 'pg'
import { loadEnv } from './_env.mjs'

loadEnv()

const BASE = process.env.TEST_BASE_URL ?? 'https://the-awakening-portal.vercel.app'
const RUNS = 7

async function time(fn) {
  const samples = []
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now()
    try {
      await fn()
    } catch {
      /* measured regardless */
    }
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  return {
    min: Math.round(samples[0]),
    p50: Math.round(samples[Math.floor(samples.length / 2)]),
    max: Math.round(samples[samples.length - 1]),
  }
}

async function get(path) {
  const res = await fetch(`${BASE}/api${path}`, { signal: AbortSignal.timeout(20_000) })
  await res.text()
  return res.status
}

async function post(path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  await res.text()
  return res.status
}

const row = (label, s, note) =>
  console.log(
    `  ${label.padEnd(34)} min=${String(s.min).padStart(5)}ms  p50=${String(s.p50).padStart(5)}ms  max=${String(s.max).padStart(5)}ms  ${note ?? ''}`,
  )

console.log(`\n  Latency breakdown — ${BASE}\n`)

// Baseline: one query behind the HTTP layer.
await get('/event') // warm
row('GET /event  (1 query)', await time(() => get('/event')), 'HTTP + 1 Neon round trip')

row('GET /teams  (1 query)', await time(() => get('/teams')))

// Unknown endpoint: still enters the function, still does nothing in the DB.
// The gap against /event is pure function + platform overhead.
row('GET /nope   (0 queries)', await time(() => get('/nope')), 'HTTP + function only')

// bcrypt without a write: a login for a number that does not exist is one
// lookup plus a dummy compare, so it isolates hashing cost.
const probe = `98765${String(Date.now()).slice(-4)}`
row(
  'POST /attendee/login (miss)',
  await time(() =>
    post('/attendee/login', { name: 'nobody', phone: probe, password: 'wrongpassword1' }),
  ),
  'adds a bcrypt COMPARE',
)

// Raw database round trip, no HTTP in the way.
const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
await client.query('select 1')
row(
  'pg: select 1 (no HTTP)',
  await time(() => client.query('select 1')),
  'raw Neon round trip from this machine',
)
row(
  'pg: indexed lookup by phone',
  await time(() => client.query('select id from attendees where phone = $1', [probe])),
)
await client.end()

console.log('')
