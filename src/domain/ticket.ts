/**
 * Ticket signing.
 *
 * A check-in ticket must not be forgeable, or anyone could walk in by
 * screenshotting a QR. The ticket is therefore `<payload>.<signature>` where
 * the signature is an HMAC over the payload.
 *
 * In production the HMAC key lives on the server and this module is not used
 * at all — the server issues and verifies. It exists here so the mock can
 * enforce the same rule offline.
 */

const DEV_SECRET = 'gdg-dev-ticket-secret'

const encoder = new TextEncoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return toBase64Url(new Uint8Array(signature))
}

/** Issues a signed ticket. Single-use is enforced by the store, not the token. */
export async function signTicket(payload: string): Promise<string> {
  return `${payload}.${await hmac(payload, DEV_SECRET)}`
}

/** Verifies a ticket's signature and returns its payload, or null if forged. */
export async function verifyTicket(ticket: string): Promise<string | null> {
  const separator = ticket.lastIndexOf('.')
  if (separator <= 0) return null

  const payload = ticket.slice(0, separator)
  const signature = ticket.slice(separator + 1)

  // Length check first: comparing a wrong-length string is wasted work.
  const expected = await hmac(payload, DEV_SECRET)
  if (expected.length !== signature.length) return null

  // Constant-time compare. A plain `===` leaks the match position via timing.
  let mismatch = 0
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index)
  }

  return mismatch === 0 ? payload : null
}