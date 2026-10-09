/**
 * Session probing that does not log people out.
 *
 * The bug this exists to fix: a failed session probe was treated as "nobody is
 * signed in". The probe has an 8-second timeout, because a stalled connection
 * would otherwise leave the boot screen up for ever — a deliberate and correct
 * trade. But routing its *failure* to `anonymous` meant that one slow request on
 * venue wifi turned a perfectly valid cookie into a redirect to /login.
 *
 * That reads, to the person experiencing it, as "the portal logged me out". And it
 * happens most on a manual refresh, which is the worst possible moment: a refresh
 * is a cold serverless start on a phone that has just come off a lock screen, so it
 * is the single most likely request in the session to be slow.
 *
 * So: failure is UNKNOWN, not anonymous. It is retried, and only a second failure
 * concludes anything.
 *
 * Why exactly one retry, and not a proper backoff loop. Each attempt can burn the
 * full probe budget, so three attempts is up to 24 seconds of boot screen plus the
 * gaps. Twenty-four seconds with no way forward is worse than showing the sign-in
 * form, which is where this left people before. One retry covers the transient case
 * — the overwhelmingly common one — in about 200ms, and genuinely offline people
 * still reach a page they can act on.
 *
 * There is also a second, quieter win here. Because a retry that *succeeds* and
 * finds a session flips the provider to `active` after the user has already been
 * sent to /login, the route guard redirects them straight back to the dashboard.
 * So the recovery is automatic and needs nothing from the user.
 */
export type ProbeResult<T> = { readonly known: true; readonly value: T | null } | { readonly known: false }

/** Pause between the first attempt and the retry. Long enough to not be a hot loop. */
const RETRY_DELAY_MS = 400

export async function probeSession<T>(probe: () => Promise<T | null>): Promise<ProbeResult<T>> {
  try {
    return { known: true, value: await probe() }
  } catch {
    // Not concluded yet. One more attempt.
  }

  await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAY_MS))

  try {
    return { known: true, value: await probe() }
  } catch {
    return { known: false }
  }
}