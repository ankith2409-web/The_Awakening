import { Pool } from 'pg'

/**
 * How many connections this process may hold open.
 *
 * MEASURED, not guessed. `scripts/load-test.mjs` drives 450 arrivals at a running
 * API and reports p50 and p95; these are its numbers, on the same database
 * production uses, at 40 arrivals in flight:
 *
 *     max =  5    p50 3318ms   p95 4008ms
 *     max = 10    p50 1587ms   p95 2486ms
 *     max = 20    p50  735ms   p95 1246ms
 *     max = 30    p50  498ms   p95 1681ms
 *     max = 40    p50  368ms   p95 1050ms
 *     max = 50    p50  395ms   p95 2131ms
 *
 * The original 5 was the single largest cost on the door. A check-in makes four
 * round trips, so five connections can only ever have five of them in progress:
 * everybody else queued, and a student's wait became a function of how many people
 * were ahead of them rather than of how long their own check-in took. Four
 * hundred and fifty arrivals still all succeeded — they just took three seconds
 * each, which at a busy door is the difference between a queue and a crowd.
 *
 * 30 IS THE CHOSEN NUMBER, NOT THE FASTEST ONE. Forty posts a slightly better p50
 * and fifty is worse than both, because past about forty the cost of opening
 * connections during a cold start overtakes what the extra concurrency saves.
 *
 * Since a Vercel burst lands across several lambda instances at once, each holding
 * its own pool, the conservative side of the optimum is the right side: forty might
 * be faster on this machine and slower in production, and the margin is 130ms.
 *
 * SAFE BECAUSE THIS IS THE POOLED ENDPOINT. `DATABASE_URL` ends in `-pooler`, which
 * multiplexes many client connections over a small number of real ones, and the
 * server reports `max_connections` of 901. On a direct endpoint this number would
 * be dangerous and would need to be far smaller.
 *
 * Overridable, because the right value depends on the plan and because a
 * measurement taken on someone else's machine should not require editing source.
 */
const DEFAULT_POOL_MAX = 30

/**
 * Connection pool.
 *
 * A module-level singleton so a warm lambda reuses connections instead of opening
 * a new one per request. `pg` keeps the socket alive between calls.
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

    const configured = Number(process.env.DATABASE_POOL_MAX)
    const max =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POOL_MAX

    pool = new Pool({
      connectionString,
      max,
      // Neon closes idle sockets aggressively; fail fast rather than hang.
      connectionTimeoutMillis: 10_000,
      /*
        Verification stays off. It was off before this change and it is not what
        caused anything measured above — turning it on is a separate decision about
        trusting the certificate chain, and it belongs with whoever owns the Neon
        account rather than in a commit about connection counts.
      */
      ssl: { rejectUnauthorized: false },
    })
  }
  return pool
}
