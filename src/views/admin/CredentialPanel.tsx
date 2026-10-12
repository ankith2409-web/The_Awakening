import { useCallback, useState } from 'react'
import { portalApi } from '@/api'
import { Button } from '@/components/Button'
import type { CredentialSendResult } from '@/domain/types'

/**
 * Send every attendee their own login details, by email.
 *
 * THE BUTTON IS A ROTATION, AND SAYS SO.
 *
 * It cannot resend a password, because only a bcrypt hash is stored and a hash is
 * not reversible. So it generates a NEW one, and every password it issues
 * invalidates the one that attendee had. That is a real consequence and the copy
 * above the button says so, rather than letting somebody discover it after the
 * fact by finding that yesterday's login stopped working.
 *
 * WHY IT IS OWNER-ONLY
 *
 * A broadcast reaches every attendee on their own phone, and so does this. `gate`
 * exists to mark people present at a door; handing over credentials is not a
 * door-side job. The server refuses it independently — this is presentation, not
 * the control.
 *
 * WHY THE REPORT IS THE POINT
 *
 * "Sent 480" is a claim about the world. The panel instead shows who was skipped
 * for having no address on file, and who failed, because those two lists are the
 * difference between an owner who knows exactly who to chase and one who finds
 * out from a person who could not log in on the morning of the event.
 */

export function CredentialPanel() {
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<CredentialSendResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const send = useCallback(async () => {
    setSending(true)
    setProblem(null)
    setResult(null)
    try {
      setResult(await portalApi.sendCredentials())
    } catch (cause) {
      /*
        Never "we could not reach the server", which is what the generic copy says.
        This one action changes every attendee's password, so an owner who does not
        know whether it ran cannot safely press it again — and pressing it again
        would invalidate the passwords it just sent.
      */
      setProblem(
        'The portal could not be reached, so nothing was changed. Check your connection before trying again — pressing this twice issues two different passwords.',
      )
      void cause
    } finally {
      setSending(false)
    }
  }, [])

  return (
    <section className="border-2 border-swiss-ink">
      <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
        Send credentials
      </h2>

      <div className="flex flex-col gap-6 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <p className="flex-1 text-2xs font-medium leading-relaxed text-content-muted">
            Emails every attendee their name, phone, password and portal link — one
            message each, to the address they registered with.
          </p>
          <Button variant="accent" size="lg" loading={sending} onClick={() => void send()}>
            {sending ? 'Sending' : 'Email login details'}
          </Button>
        </div>

        {/*
          The consequence, stated before the button and not after.

          This replaces every attendee's password. Somebody holding yesterday's
          password cannot use it afterwards, which is the whole point — an email an
          attacker already read is a password that is no longer worth anything — but
          it is still a change to four hundred people's accounts and the owner
          should be reaching for it deliberately.
        */}
        <p className="border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-medium leading-relaxed text-content-muted">
          <span className="font-bold uppercase tracking-[0.2em] text-swiss-ink">
            This issues new passwords.
          </span>{' '}
          It cannot repeat the ones already sent, because the portal stores only a
          hash — so every password it issues replaces the one that attendee had.
          Their current password stops working the moment the email arrives.
        </p>

        {problem !== null ? (
          <p
            role="alert"
            className="border-2 border-swiss-ink bg-swiss-muted p-4 text-2xs font-medium leading-relaxed text-swiss-ink"
          >
            {problem}
          </p>
        ) : null}

        {result !== null ? (
          <div className="flex flex-col gap-4">
            <p
              role="status"
              className="border-2 border-swiss-ink p-4 text-2xs font-medium leading-relaxed text-swiss-ink"
            >
              {result.message}
            </p>

            {!result.configured ? (
              <p className="text-2xs font-medium leading-relaxed text-content-muted">
                No email service is configured on this deployment, so nothing was sent
                and nothing was changed. Every password is exactly as it was.
              </p>
            ) : null}

            {result.skipped.length > 0 ? (
              <details className="border-2 border-swiss-ink">
                <summary className="cursor-pointer bg-swiss-muted px-4 py-3 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
                  {result.skipped.length} with no email on file
                </summary>
                <div className="p-4">
                  <p className="text-2xs font-medium leading-relaxed text-content-muted">
                    These registered before the portal collected addresses, or were
                    added at the desk without one. Set a password for them from People,
                    or send it however you normally do.
                  </p>
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {result.skipped.map((sen) => (
                      <li
                        key={sen}
                        className="border border-swiss-ink px-2 py-1 font-mono text-2xs font-bold text-swiss-ink"
                      >
                        {sen}
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            ) : null}

            {result.failures.length > 0 ? (
              <details className="border-2 border-swiss-ink">
                <summary className="cursor-pointer bg-swiss-muted px-4 py-3 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
                  {result.failures.length} could not be delivered
                </summary>
                <div className="p-4">
                  {/*
                    Say what happened to their password, because this is the line that
                    stops somebody being locked out.

                    Every one of these had their NEW password rolled back, so they
                    still have the one they had before. They can log in exactly as they
                    could this morning.
                  */}
                  <p className="text-2xs font-medium leading-relaxed text-content-muted">
                    Their password was put back, so they can still log in with the one
                    they had. The usual cause is a mistyped or full mailbox.
                  </p>
                  <ul className="mt-3 flex flex-col gap-2">
                    {result.failures.map((failure) => (
                      <li key={failure.sen} className="text-2xs text-content-muted">
                        <span className="font-mono font-bold text-swiss-ink">
                          {failure.sen}
                        </span>{' '}
                        — {failure.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}