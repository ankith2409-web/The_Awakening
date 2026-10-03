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
  | 'weak_password'
  | 'invalid_ticket'
  | 'unknown_sen'
  | 'already_checked_in'
  | 'not_found'
  | 'forbidden'
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

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw badRequest('unknown', 'Malformed JSON body')
  }
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

export function isTrue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1
}

export { type IncomingMessage, type ServerResponse }