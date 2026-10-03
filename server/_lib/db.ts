import { Pool } from 'pg'

/**
 * Connection pool.
 *
 * A module-level singleton so a warm lambda reuses connections instead of
 * opening a new one per request. `pg` keeps the socket alive between calls.
 */
let pool: Pool | null = null

export function db(): Pool {
  if (pool === null) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Add it in Vercel → Project → Settings → Environment Variables.',
      )
    }
    pool = new Pool({
      connectionString,
      // Neon is serverless: cap connections so we never exhaust the pooler.
      max: 5,
      ssl: { rejectUnauthorized: false },
      // Neon closes idle sockets aggressively; fail fast rather than hang.
      connectionTimeoutMillis: 10_000,
    })
  }
  return pool
}