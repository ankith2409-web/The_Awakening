import { createHmac } from 'node:crypto'
import { normaliseSen } from './identifiers.ts'

/**
 * Signed QR payloads.
 *
 * The QR an attendee shows encodes their SEN plus an HMAC signature over it.
 * The signature does not authorise attendance — the admin session does. What it
 * proves is that *this pass was issued by us and for this SEN*.
 *
 * That distinction matters because the gate also accepts a bare SEN: staff can
 * type one, or a printed barcode carries no signature. Without verification,
 * reading a SEN off someone's lanyard is enough to mark them present. With it,
 * a scan can be told apart from a guess, and the difference is recorded.
 *
 * The key lives only on the server; the client never sees it.
 */

export type AdmissionMethod = 'qr' | 'printed'

function secret(): string {
  const value = process.env.TICKET_SECRET
  if (!value || value.length < 16) {
    throw new Error(
      'TICKET_SECRET is missing or too short (min 16 chars). Set it in Vercel → Environment Variables.',
    )
  }
  return value
}

export function signSen(sen: string): string {
  return `${sen}.${createHmac('sha256', secret()).update(sen).digest('base64url')}`
}

/**
 * Verifies a scanned payload and returns the SEN plus how it was admitted.
 *
 * Never throws. A missing or rotated `TICKET_SECRET` must not take the gate
 * offline — the worst case is that a genuine QR scan is reported as `printed`,
 * which staff already handle, rather than a 500 that stalls the queue.
 */
export function readTicket(raw: string): { sen: string; method: AdmissionMethod } {
  const candidate = raw.trim()

  const dot = candidate.lastIndexOf('.')
  if (dot > 0) {
    const sen = candidate.slice(0, dot)
    const signature = candidate.slice(dot + 1)

    try {
      if (constantTimeEquals(createHmac('sha256', secret()).update(sen).digest('base64url'), signature)) {
        return { sen: normaliseSen(sen), method: 'qr' }
      }
    } catch {
      // Fall through to the unsigned path below.
    }
  }

  return { sen: normaliseSen(candidate), method: 'printed' }
}

/** Compares without leaking the match position through timing. */
function constantTimeEquals(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false

  let mismatch = 0
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ actual.charCodeAt(index)
  }
  return mismatch === 0
}
