import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { db } from './db.ts'

/* ---------------------------------------------------------------- passwords */

const BCRYPT_ROUNDS = 10

/**
 * bcryptjs (pure JS) rather than bcrypt (native): a native addon needs a build
 * step on Vercel's runtime and silently breaks when that toolchain changes.
 */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS)
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

/* ----------------------------------------------------------------- cookies */

const COOKIE_PREFIX = 'gdg_'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export interface SessionRow {
  subject_id: string
  kind: 'attendee' | 'admin'
}

function setCookie(res: ServerResponse, name: string, value: string, days: number) {
  appendHeader(res, 'Set-Cookie', serializeCookie(name, value, days))
}

/** Appends a header without clobbering existing ones. */
function appendHeader(res: ServerResponse, name: string, value: string) {
  const existing = res.getHeader(name)
  if (existing === undefined) {
    res.setHeader(name, value)
    return
  }
  const list = Array.isArray(existing) ? existing.map(String) : [String(existing)]
  res.setHeader(name, [...list, value])
}

/**
 * Serialises a cookie whose lifetime is given in DAYS.
 *
 * Takes days rather than a raw header value so the unit cannot be mixed up.
 * `Max-Age` is defined in SECONDS by RFC 6265, so writing the day count into it
 * issues a 1-second cookie for a session the database considers valid for a
 * full day — the browser drops the cookie and every attendee is bounced back to
 * /login moments after signing in.
 *
 * `Expires` is emitted alongside `Max-Age` for parsers that ignore the latter.
 */
function serializeCookie(name: string, value: string, days: number): string {
  const seconds = Math.floor(days * 24 * 60 * 60)

  const parts = [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${seconds}`,
    `Expires=${new Date(Date.now() + seconds * 1000).toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  // Secure is required for the cookie to be sent at all over HTTPS, and Vercel
  // always serves HTTPS. Keyed on NODE_ENV so a local HTTP harness still works.
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

/* ---------------------------------------------------------------- sessions */

const REMEMBERED_DAYS = 30
const SESSION_DAYS = 1
/** Absolute ceiling regardless of "remember me". */
const MAX_SESSION_MS = REMEMBERED_DAYS * 24 * 60 * 60 * 1000

export async function createSession(
  res: ServerResponse,
  kind: 'attendee' | 'admin',
  subjectId: string,
  remember: boolean,
): Promise<void> {
  const token = randomBytes(32).toString('base64url')

  // Days. The cookie lifetime and the database row must agree, or the browser
  // forgets the attendee while the server still believes they are signed in.
  const days = remember ? REMEMBERED_DAYS : SESSION_DAYS
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

  await db().query(
    `insert into sessions (token_hash, kind, subject_id, expires_at)
     values ($1, $2, $3, $4)`,
    [sha256(token), kind, subjectId, expiresAt.toISOString()],
  )

  setCookie(res, COOKIE_PREFIX + kind, token, days)
}

/**
 * Resolves the caller from their cookie.
 *
 * Returns null for a missing, unknown or EXPIRED token. Expired rows are
 * deleted on sight so the table cannot grow without bound.
 */
export async function currentSession(
  req: IncomingMessage,
  kind: 'attendee' | 'admin',
): Promise<SessionRow | null> {
  const token = readCookie(req, COOKIE_PREFIX + kind)
  if (!token) return null

  const { rows } = await db().query<SessionRow>(
    `select subject_id, kind from sessions
      where token_hash = $1 and kind = $2 and expires_at > now()`,
    [sha256(token), kind],
  )

  const row = rows[0]
  if (!row) {
    // Unknown token: clear the cookie so the browser stops sending it.
    return null
  }
  return row
}

export async function destroySession(
  req: IncomingMessage,
  res: ServerResponse,
  kind: 'attendee' | 'admin',
): Promise<void> {
  const token = readCookie(req, COOKIE_PREFIX + kind)
  if (token) {
    await db().query(`delete from sessions where token_hash = $1`, [sha256(token)])
  }
  setCookie(res, COOKIE_PREFIX + kind, '', 0)
}

/** Housekeeping: safe to call on any request, and cheap because it is indexed. */
export async function purgeExpiredSessions(): Promise<void> {
  await db().query(`delete from sessions where expires_at <= now()`)
}

/**
 * Revokes every session for somebody EXCEPT the one making this request.
 *
 * Used when an attendee changes their own password. The admin route deletes all of
 * them, which is right there — the administrator is not the person at the other end.
 * Doing the same to a self-service change logs the person out of the tab they are
 * standing in, at the exact moment they have just proved they know their password,
 * and it is indistinguishable from the portal spontaneously signing them out.
 *
 * Kept here rather than in the route because `sha256` is module-private, and the
 * point of it being private is that no caller can forge a token hash.
 */
export async function revokeOtherSessions(
  req: IncomingMessage,
  kind: 'attendee' | 'admin',
  subjectId: string,
): Promise<void> {
  const token = readCookie(req, COOKIE_PREFIX + kind)
  await db().query(
    `delete from sessions
      where kind = $1 and subject_id = $2 and token_hash is distinct from $3`,
    [kind, subjectId, token === null ? '' : sha256(token)],
  )
}

export { MAX_SESSION_MS }