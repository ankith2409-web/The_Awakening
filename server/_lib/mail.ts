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

/**
 * Where replies to anything this portal sends should land.
 *
 * The GDG technical team, not the person whose Resend account pays for the sends.
 * A team leader replying to their pass should be talking to the chapter, and the
 * chapter is an address that outlives whoever set the portal up.
 *
 * DUPLICATED FROM `src/domain/contact.ts` ON PURPOSE, and pinned by a test.
 *
 * The server and the client do not share modules — the same reasoning that keeps
 * `server/_lib/identifiers.ts` separate from `src/domain/phone.ts` — so this
 * address is written twice. The risk is that the two drift and the footer promises
 * one inbox while the reply button opens another, so `scripts/test-copy.mjs`
 * asserts the two files agree. Change one and the suite tells you about the other.
 */
const ORGANISER_EMAIL = 'gdgtechnicalteam@gmail.com'

/**
 * The display name on the From line.
 *
 * "The Awakening <…>" rather than the bare address, because a leader scrolling
 * their inbox sees the sender, not the envelope, and the sender should be the
 * event.
 */
const SENDER_NAME = 'The Awakening'

/**
 * The From address, overridable so a verified sending domain can be swapped in
 * without a code change.
 *
 * THE DEFAULT IS THE GDG ADDRESS AND THAT IS A DELIBERATE CHOICE WITH A LIMIT.
 * A mail provider will only send from a domain it has verified, or from the
 * account owner's own address while testing. `gdgtechnicalteam@gmail.com` is
 * neither by default, so on an unverified account this send is refused — and the
 * refusal is reported honestly rather than swallowed, because an organiser who is
 * told "0 sent" can go and fix DNS records, and one who is told "sent" when
 * nothing left the building cannot.
 *
 * Set `MAIL_FROM` once a domain is verified at the provider and this resolves
 * itself with no deploy.
 */
function fromAddress(): string {
  const override = process.env.MAIL_FROM?.trim()
  if (override) return override
  return `${SENDER_NAME} <${ORGANISER_EMAIL}>`
}

/**
 * The Reply-To, for the same reason as above and independently of it.
 *
 * Set even when `MAIL_FROM` has been overridden to a domain: a reply should reach
 * the chapter whether the message came from Resend, from a verified GDG domain, or
 * from a relay somebody added during the event.
 */
export function replyToAddress(): string {
  return process.env.MAIL_REPLY_TO?.trim() || ORGANISER_EMAIL
}

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

  const from = fromAddress()
  // A caller may override the reply-to for one message; otherwise every reply
  // goes to the chapter, whatever the From line happens to be.
  const replyTo = input.replyTo ?? replyToAddress()

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
        /*
          Reply-To is always present, not only when the caller asked.

          Every message this portal sends is transactional mail to a student, and a
          student who hits reply on one of them should reach the chapter. Leaving it
          unset means replies land on whatever address the provider authenticated,
          which is a billing inbox nobody reads.
        */
        reply_to: replyTo,
      }),
    })

    if (!response.ok) {
      /*
        The provider's body is read but NEVER surfaced verbatim.

        It echoes the address that failed, and an owner's error panel is not the
        place for that. It is read only to recognise three specific situations,
        because each one has a completely different fix and "the address was
        refused" sends the owner chasing the wrong person:

          - The sending domain is not verified. Nothing can be delivered to anyone,
            and no student can fix it. The fix is one DNS record, on the organiser's
            side.
          - Only the account's own address is allowed, which is what a provider
            permits before a domain exists. Same fix, said differently, because the
            owner is looking at a list of students who "could not be reached" and
            needs to know none of it is their fault.
          - Anything else. Refused, rate-limited, or down.

        The words are matched on, never printed: the messages themselves contain the
        address, and the substring tests below are what keeps it off the screen.
      */
      const detail = await response.text().catch(() => '')

      let hint: string
      if (/domain is not verified|domain you are sending from|is not verified/i.test(detail)) {
        hint = 'The sending domain is not verified, so nothing can be delivered until it is.'
      } else if (/only send testing emails to your own email address/i.test(detail)) {
        /*
          Named specifically, because this is the one failure the owner CAN fix and
          the message they get from it is otherwise baffling: the portal says it
          emails a team leader, the provider says it only mails one address, and
          nothing in either sentence names the From line as the thing that has to
          change. Saying so here is the difference between an owner googling and an
          owner verifying a domain.
        */
        hint =
          'The from-address is not verified with the mail provider, so nothing was delivered. ' +
          'Verify a sending domain, or send from the address on the provider account.'
      } else if (detail.includes('validation_error')) {
        hint = 'The address was refused.'
      } else {
        hint = `The mail service replied ${response.status}.`
      }

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