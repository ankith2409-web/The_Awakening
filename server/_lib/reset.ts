import { db } from './db.ts'

/**
 * Housekeeping for the password-reset attempt ledger.
 *
 * Everything else that lived here is gone, and its removal is the point.
 *
 * This file used to implement the rate limiter for the **unverified**
 * self-service password reset — per-phone and per-IP budgets, a uniform
 * response so the endpoint could not be used to enumerate the roster, and a
 * dummy bcrypt compare so response time did not leak existence either.
 *
 * All of that defended an endpoint where knowing a phone number was enough to
 * take over that account and walk in with the attendee's pass. It was the most
 * serious weakness in the portal, and the endpoint was under active probing in
 * production.
 *
 * Password recovery is now admin-mediated: an attendee asks an organiser at the
 * desk and `POST /admin/attendees/password` sets a new one. That requires an
 * authenticated admin session, so there is nothing left for a rate limiter to
 * defend — an attacker cannot reach the route at all. Deleting the endpoint was
 * the fix; the limiter existed only to make its absence less catastrophic.
 *
 * The note that used to sit here is worth keeping, because the mistake is
 * instructive: there was once a "clear the counter on success" helper. It
 * worked, and it defeated the entire limiter — a successful reset deleted its
 * own attempt history, so the count never reached the limit and a caller could
 * reset the same account indefinitely. Counting the successful attempt is what
 * gives a budget any meaning. `test:gate` asserted the limit engaged for
 * exactly this reason.
 */

/**
 * Best-effort cleanup so the ledger cannot grow without bound.
 *
 * The table is no longer written to. The rows it holds are an accurate record of
 * the probing that endpoint received, so this keeps a short window rather than
 * clearing the table — and it deliberately never touches `password_changes`,
 * which is the audit trail for the flow that replaced it.
 */
export async function purgeOldResetAttempts(): Promise<void> {
  await db().query(
    `delete from password_reset_attempts where created_at < now() - interval '2 days'`,
  )
}