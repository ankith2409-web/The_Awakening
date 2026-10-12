/**
 * Transactional email, via the Resend HTTP API.
 *
 * Plain `fetch` and no SDK. One request shape, one dependency the project does
 * not have, and a deployment that cannot fail to resolve an import — which is
 * the same reasoning that keeps `server/_lib/identifiers.ts` duplicated rather
 * than shared.
 *
 * NOT CONFIGURED IS NORMAL, NOT AN ERROR.
 *
 * There is no API key yet. Everything that sends email is therefore a no-op that
 * reports honestly, and the portal behaves exactly as it did before this file
 * existed. That is deliberate: the feature is built and shipped first, and the
 * key switches it on. A deployment with no key must not 500 on registration.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/** Refused rather than retried forever: a rejected address will not become valid. */
const TIMEOUT_MS = 10_000

export interface MailResult {
  /** Whether a real send was attempted. False when no API key is configured. */
  readonly attempted: boolean
  readonly ok: boolean
  /** The provider's own identifier, for an audit trail. */
  readonly id: string | null
  /** Why it failed, safe to show an owner. Never contains the message body. */
  readonly error: string | null
}

const NOT_CONFIGURED: MailResult = {
  attempted: false,
  ok: false,
  id: null,
  error: 'No email service is configured on this deployment.',
}

export function mailConfigured(): boolean {
  const key = process.env.RESEND_API_KEY
  return typeof key === 'string' && key.trim() !== ''
}

/**
 * Sends one message.
 *
 * `text` and `html` are both supplied by the caller and both are required: a
 * plain-text part is what a mail client falls back to, and the HTML part is what
 * somebody actually reads. Sending HTML alone is how an email ends up as a blank
 * page in some clients.
 *
 * Never throws. A failed email must not take down the request that triggered it —
 * for a registration that would mean losing the registration because an inbox
 * was full.
 */
export async function sendMail(input: {
  to: string
  subject: string
  text: string
  html: string
  replyTo?: string
}): Promise<MailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  if (!apiKey) return NOT_CONFIGURED

  const from = process.env.MAIL_FROM?.trim() || 'The Awakening <onboarding@resend.dev>'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    })

    if (!response.ok) {
      /*
        The provider's body is read but never surfaced verbatim: it echoes the
        address that failed, and an owner's error panel is not the place for that.
        The status is enough to act on, and the address is already on their roster.
      */
      const detail = await response.text().catch(() => '')
      const hint = detail.includes('validation_error')
        ? 'The address was refused.'
        : `The mail service replied ${response.status}.`
      return { attempted: true, ok: false, id: null, error: hint }
    }

    const body = (await response.json()) as { id?: unknown }
    return {
      attempted: true,
      ok: true,
      id: typeof body.id === 'string' ? body.id : null,
      error: null,
    }
  } catch (cause) {
    const reason =
      cause instanceof Error && cause.name === 'AbortError'
        ? 'The mail service did not answer in time.'
        : 'The mail service could not be reached.'
    return { attempted: true, ok: false, id: null, error: reason }
  } finally {
    clearTimeout(timer)
  }
}