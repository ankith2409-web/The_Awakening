import { randomUUID } from 'node:crypto'
import webpush from 'web-push'
import { db } from './db.ts'

/**
 * Web Push.
 *
 * The channel the owner has for reaching somebody who is not looking at the portal —
 * which, on the day, is most of them. Phones face down in a queue, a laptop in a
 * backpack, a tab that was closed an hour ago. An in-page banner cannot reach any of
 * those; this can, and it is why this feature is worth having rather than a box on
 * the dashboard.
 *
 * WHY NO EXTERNAL SERVICE ACCOUNT
 *
 * Every other way of messaging attendees needs something we do not have: an email
 * provider and a verified sending domain, or a telecom account and a DLT-registered
 * sender ID. Push needs neither. VAPID keys are *self-generated* — a P-256 pair created
 * once and stored in the environment — and the delivery itself is handled by the
 * browser vendor's push service, which Chrome already talks to for every site. So this
 * is the one channel that runs entirely on infrastructure we already have.
 *
 * WHAT THE KEYS ARE FOR
 *
 * The public key is handed to the browser so it can address us, and is not a secret.
 * The private key signs every request we make to the push service; with it, nobody
 * else can address our subscribers, and without it, we cannot address them. It is
 * generated once and never rotated casually — rotating invalidates every subscription
 * we hold, and every attendee would have to opt in again.
 */

/** VAPID's hard ceiling on a push payload. Anything larger is refused by every browser. */
const MAX_PAYLOAD_BYTES = 4_096

/**
 * How many sends run at once.
 *
 * Sequential is the obvious thing and it is wrong here: each send is a round trip to
 * the push service, so a broadcast to a few hundred phones would run past a serverless
 * timeout and the owner would be told it failed when in fact most of it went out.
 *
 * Capped rather than unbounded because the alternative failure is just as bad — a
 * few hundred simultaneous TLS handshakes looks like a denial of service from inside
 * our own function, and the push service rate-limits or drops on the far end.
 */
const SEND_CONCURRENCY = 12

export interface Announcement {
  id: string
  title: string
  body: string
  createdAt: string
}

export interface BroadcastResult {
  /** Subscriptions the service accepted. */
  sent: number
  /** Subscriptions we dropped because the service reported them gone. */
  pruned: number
  /** Subscriptions that failed for a reason worth retrying — a flaky network, a rate limit. */
  failed: number
  /** How many were live at the start of the send. */
  total: number
}

/* ------------------------------------------------------------------ config */

function readKey(name: 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY'): string {
  const value = process.env[name]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Whether this deployment can send at all.
 *
 * Reported to the UI rather than assumed. A deployment with the keys missing must show
 * the owner "push is not configured", not accept a message and silently deliver
 * nothing — on the day that is the one failure that cannot be noticed and cannot be
 * fixed in time.
 */
export function pushConfigured(): boolean {
  return readKey('VAPID_PUBLIC_KEY').length > 0 && readKey('VAPID_PRIVATE_KEY').length > 0
}

/**
 * The public key, to be embedded in a subscription request.
 *
 * Null when unconfigured. The client treats that as "this deployment cannot do push"
 * and hides the toggle, rather than offering a button that cannot work.
 */
export function vapidPublicKey(): string | null {
  return pushConfigured() ? readKey('VAPID_PUBLIC_KEY') : null
}

/**
 * Register the VAPID details, once per process.
 *
 * `webpush.setVapidDetails` is global and idempotent for the same subject, but calling
 * it per request would mean validating the key length on every broadcast. Doing it
 * lazily keeps the cost off the request path that does not need it.
 */
let configuredFor: string | null = null

function ensureConfigured(): void {
  if (!pushConfigured()) return
  const subject = (process.env.VAPID_SUBJECT ?? 'mailto:ankith2409@gmail.com').trim()
  const identity = `${subject}|${readKey('VAPID_PUBLIC_KEY')}`
  if (configuredFor === identity) return
  webpush.setVapidDetails(subject, readKey('VAPID_PUBLIC_KEY'), readKey('VAPID_PRIVATE_KEY'))
  configuredFor = identity
}

/* ------------------------------------------------------- subscription store */

/**
 * Record a subscription, or refresh it if we already hold that endpoint.
 *
 * Upsert rather than insert, because re-subscribing is normal and not an error: a user
 * can grant permission, revoke it and grant it again, and browsers also re-issue on
 * some profile moves. Failing on the second attempt would make the toggle look broken
 * when it had worked.
 *
 * `last_seen_at` moves on every touch, which is what tells us something still works
 * months later — or does not, and should be pruned.
 */
export async function saveSubscription(input: {
  endpoint: string
  keys: { p256dh: string; auth: string }
  userAgent: string | null
}): Promise<void> {
  await db().query(
    `insert into push_subscriptions (endpoint, p256dh, auth, user_agent, last_seen_at)
          values ($1, $2, $3, $4, now())
     on conflict (endpoint) do update
            set p256dh = excluded.p256dh,
                auth = excluded.auth,
                user_agent = excluded.user_agent,
                last_seen_at = now()`,
    [input.endpoint, input.keys.p256dh, input.keys.auth, input.userAgent],
  )
}

export async function removeSubscription(endpoint: string): Promise<boolean> {
  const result = await db().query('delete from push_subscriptions where endpoint = $1', [endpoint])
  return (result.rowCount ?? 0) > 0
}

export async function subscriptionCount(): Promise<number> {
  const result = await db().query<{ n: number }>('select count(*)::int as n from push_subscriptions')
  return result.rows[0].n
}

/* ------------------------------------------------------------ announcements */

/**
 * Record an announcement, so the owner has a history and `/event` has something to
 * carry for people push could not reach.
 */
export async function recordAnnouncement(input: {
  title: string
  body: string
  sentBy: string | null
}): Promise<Announcement> {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  await db().query(
    `insert into announcements (id, title, body, sent_by) values ($1, $2, $3, $4)`,
    [id, input.title, input.body, input.sentBy],
  )
  return { id, title: input.title, body: input.body, createdAt }
}

/**
 * The newest announcement, for the dashboard.
 *
 * One, not a feed. This is a fallback for somebody who missed a push, not a message
 * centre — the answer to "did they hear about the room change" is the current state of
 * the world, not the history of it.
 */
export async function latestAnnouncement(): Promise<Announcement | null> {
  const result = await db().query<{
    id: string
    title: string
    body: string
    created_at: Date
  }>(
    `select id, title, body, created_at from announcements order by created_at desc limit 1`,
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  }
}

/* ---------------------------------------------------------------- the send */

/**
 * Push to every subscription we hold.
 *
 * Dead endpoints are deleted as a side effect. That is not housekeeping bolted on —
 * a subscription that 404s will 404 forever, and a broadcast to four hundred endpoints
 * of which two hundred are dead is twice as slow as it needs to be for every future
 * send, on the one day it matters most.
 *
 * A transient failure is counted but never deletes. The distinction is the whole
 * point: 404/410 means the browser is gone, anything else means the network hiccupped,
 * and treating those alike would silently unsubscribe people whose phone went into a
 * tunnel for four seconds.
 */
export async function broadcast(input: {
  title: string
  body: string
  url?: string
}): Promise<BroadcastResult> {
  const empty: BroadcastResult = { sent: 0, pruned: 0, failed: 0, total: 0 }
  if (!pushConfigured()) return empty

  ensureConfigured()

  const subscriptions = await db().query<{
    endpoint: string
    p256dh: string
    auth: string
  }>(`select endpoint, p256dh, auth from push_subscriptions`)

  const rows = subscriptions.rows
  if (rows.length === 0) return empty

  const payload = JSON.stringify({
    title: input.title,
    body: input.body,
    url: input.url ?? '/',
  })

  /*
    Truncated rather than rejected.

    A message that will not fit is a message the owner still wants to send, and Chrome
    will refuse it outright rather than send a piece. Cutting the body keeps the
    notification arriving with the title intact — which is the part people read at a
    glance — instead of failing the send entirely.
  */
  const sendable =
    Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES
      ? JSON.stringify({
          title: input.title,
          body: input.body.slice(0, 200),
          url: input.url ?? '/',
        })
      : payload

  const dead: string[] = []
  let sent = 0
  let failed = 0
  let cursor = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= rows.length) return
      const row = rows[index]
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          sendable,
        )
        sent += 1
      } catch (cause) {
        const status = (cause as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) dead.push(row.endpoint)
        else failed += 1
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SEND_CONCURRENCY, rows.length) }, () => worker()),
  )

  if (dead.length > 0) {
    await db().query('delete from push_subscriptions where endpoint = any($1::text[])', [dead])
  }

  return { sent, pruned: dead.length, failed, total: rows.length }
}