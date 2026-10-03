import type { ServerResponse } from 'node:http'
import { db } from './db.ts'

/**
 * Rate limiting for the unverified password reset.
 *
 * Reset is unverified by the organiser's explicit decision, which makes it an
 * account-takeover path: anyone who knows a phone number can set a new password
 * on that account and walk in with the attendee's pass. Because there is no
 * verification step to slow an attacker down, this is the only control between
 * that and a script walking all ~500 numbers.
 *
 * Two independent budgets, because they defend against different attacks:
 *
 *   per phone — one attacker grinding a single known number
 *   per IP    — one host sweeping the whole roster
 *
 * Counting lives in Postgres rather than process memory because serverless
 * instances are ephemeral and not shared: an in-memory counter would reset on
 * every cold start and on every concurrent invocation, so the effective limit
 * would be "however many guesses fit in one function's lifetime".
 */

/** Attempts allowed per number, per hour. */
const PHONE_LIMIT = 5
/** Attempts allowed per caller IP, per hour. Generous for a shared venue NAT. */
const IP_LIMIT = 20

const WINDOW = '1 hour'

export class RateLimited extends Error {
  // Declared rather than assigned as constructor parameter properties: the
  // project compiles with `erasableSyntaxOnly`, which forbids that syntax.
  readonly scope: 'phone' | 'ip'
  readonly retryAfterSeconds: number

  constructor(scope: 'phone' | 'ip', retryAfterSeconds: number) {
    super(
      scope === 'phone'
        ? 'Too many reset attempts for this number. Try again later.'
        : 'Too many reset attempts from this device. Try again later.',
    )
    this.name = 'RateLimited'
    this.scope = scope
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function clientIp(req: { headers: Record<string, unknown> }): string {
  // Vercel sets x-forwarded-for; the left-most entry is the original client.
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded !== '') {
    return (forwarded.split(',')[0] ?? '').trim()
  }
  return 'unknown'
}

/**
 * Records an attempt and throws if either budget is exhausted.
 *
 * Must be called BEFORE doing any work, and must record attempts that then fail
 * — otherwise the limiter only throttles people who guessed correctly.
 */
export async function consumeResetAttempt(req: { headers: Record<string, unknown> }, phone: string): Promise<void> {
  const ip = clientIp(req)

  const [{ rows: phoneRows }, { rows: ipRows }] = await Promise.all([
    db().query<{ count: string; oldest: string }>(
      `select count(*)::text as count, min(created_at)::text as oldest
         from password_reset_attempts
        where phone = $1 and created_at > now() - $2::interval`,
      [phone, WINDOW],
    ),
    db().query<{ count: string; oldest: string }>(
      `select count(*)::text as count, min(created_at)::text as oldest
         from password_reset_attempts
        where ip = $1 and created_at > now() - $2::interval`,
      [ip, WINDOW],
    ),
  ])

  const phoneCount = Number(phoneRows[0]?.count ?? '0')
  const ipCount = Number(ipRows[0]?.count ?? '0')

  const blocked =
    phoneCount >= PHONE_LIMIT
      ? ({ scope: 'phone', oldest: phoneRows[0]?.oldest } as const)
      : ipCount >= IP_LIMIT
        ? ({ scope: 'ip', oldest: ipRows[0]?.oldest } as const)
        : null

  if (blocked) {
    // Seconds until the oldest attempt in the window ages out.
    const oldest = Date.parse(blocked.oldest ?? '')
    const retryAfter = Number.isFinite(oldest)
      ? Math.max(60, Math.ceil((oldest + 3_600_000 - Date.now()) / 1000))
      : 600
    throw new RateLimited(blocked.scope, retryAfter)
  }

  await db().query(
    'insert into password_reset_attempts (phone, ip) values ($1, $2)',
    [phone, ip],
  )
}

/*
  There is deliberately no "clear the counter on success" helper.

  It was written, it worked, and it defeated the entire limiter: a successful
  reset deleted its own attempt history, so the count never reached the limit
  and a caller could reset the same account indefinitely. Counting the
  successful attempt is what makes the budget mean anything.
*/

/** Best-effort cleanup so the attempts table cannot grow without bound. */
export async function purgeOldResetAttempts(): Promise<void> {
  await db().query(`delete from password_reset_attempts where created_at < now() - interval '2 days'`)
}

/**
 * Burns roughly the same CPU as a real password comparison.
 *
 * Called when the phone number is NOT registered. Without it, a missing account
 * answers measurably faster than an existing one, and the endpoint becomes an
 * oracle for who is registered — which defeats the uniform response the
 * limiter is paired with.
 */
export async function dummyPasswordWork(): Promise<void> {
  const { compare } = await import('bcryptjs')
  await compare(
    'grid2026-not-a-real-password',
    '$2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012',
  )
}

export function setRetryAfter(res: ServerResponse, seconds: number): void {
  res.setHeader('Retry-After', String(seconds))
}
