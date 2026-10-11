import type { IncomingMessage, ServerResponse } from 'node:http'
import type { VercelRequest, VercelResponse } from '@vercel/node'

export type { VercelRequest, VercelResponse }

/**
 * Mirrors the client-side `PortalErrorCode` taxonomy.
 *
 * The client renders these codes, so any backend error must arrive as one of
 * them — otherwise the UI falls back to a generic message and loses the
 * ability to say something specific.
 */
export type ApiErrorCode =
  | 'invalid_credentials'
  | 'phone_taken'
  | 'sen_taken'
  | 'username_taken'
  | 'weak_password'
  | 'invalid_ticket'
  | 'unknown_sen'
  | 'already_checked_in'
  | 'day_locked'
  | 'not_on_list'
  | 'registration_closed'
  | 'not_found'
  | 'forbidden'
  /*
    Kept identical to the client's `PortalErrorCode`. They are two lists of the same
    vocabulary, and a code added to one and not the other is a code the client cannot
    render — it falls back to showing the machine code to an attendee. `test:errors`
    compares them, which is the only reason that has not already bitten.
  */
  | 'invalid_subscription'
  | 'push_not_configured'
  | 'push_too_long'
  | 'rate_limited'
  | 'network'
  | 'unknown'

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode

  constructor(status: number, code: ApiErrorCode, message?: string) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}

export const badRequest = (code: ApiErrorCode, message?: string) =>
  new ApiError(400, code, message)
export const unauthorized = (message?: string) =>
  new ApiError(401, 'invalid_credentials', message)
export const forbidden = (message?: string) => new ApiError(403, 'forbidden', message)
export const notFound = (message?: string) => new ApiError(404, 'not_found', message)
export const conflict = (code: ApiErrorCode, message?: string) =>
  new ApiError(409, code, message)
export const unprocessable = (code: ApiErrorCode, message?: string) =>
  new ApiError(422, code, message)

/**
 * Writes a JSON response.
 *
 * Sets `statusCode` directly rather than calling `res.status(n)`: that helper
 * is an Express/HTTP convention, not part of Node's `ServerResponse`. A Build
 * Output function is handed a plain response object, so the Express form throws
 * "res.status is not a function" on every request — including error paths,
 * which turns a handled 404 into an opaque 500.
 */
export function json(res: VercelResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * Parses a JSON body, rejecting oversized payloads.
 *
 * The limit matters because this endpoint accepts a raw scan payload; without
 * it a single request could buffer an arbitrary amount into lambda memory.
 */
export async function readJson<T>(req: VercelRequest, limitBytes = 8 * 1024): Promise<T> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw badRequest('unknown', 'Payload too large')
    chunks.push(chunk as Buffer)
  }

  if (total === 0) return {} as T

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw badRequest('unknown', 'Malformed JSON body')
  }

  /*
    A JSON document that parses but is not an OBJECT is a malformed request, and has
    to be refused here rather than left to the handler.

    The body of every route is read as a record, so `body.something` is the first thing
    each handler does. On `null` that is not "missing" but a TypeError -- reading a
    property of null throws, and it throws OUTSIDE any guard, so it surfaced as an
    unhandled 500 on registration, login, scanning, roster upload and broadcast alike.

    That is the worst of both answers. A 500 says "something went wrong at our end,
    please try again", and a student at a registration desk who retries gets the same
    response for ever, because nothing about retrying helps. The request is simply
    shaped wrong and always will be.

    An array and a bare string survive that particular crash -- `[].name` and
    `"x".name` are both undefined rather than fatal -- so they reach the handlers and
    are refused field by field. Refusing them here as well is the same answer stated
    once, in the one place that can state it.
  */
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('unknown', 'Request body must be a JSON object')
  }

  return parsed as T
}

/** Narrowing helper so route handlers read without a cast at every use. */
export function field(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('unknown', `Missing field: ${key}`)
  }
  return value
}

/**
 * A present, non-empty string field, or null.
 *
 * For fields a caller may legitimately omit, as opposed to `requireString`, which
 * refuses the request when one is missing. The distinction matters: `password` on
 * registration is optional now that the portal generates one, and treating a missing
 * value as an empty string would validate the empty string instead of falling back.
 */
export function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') return null
  return value
}

export function isTrue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1
}

export { type IncomingMessage, type ServerResponse }