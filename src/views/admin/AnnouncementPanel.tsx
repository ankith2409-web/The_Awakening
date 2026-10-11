import { useCallback, useEffect, useState } from 'react'
import { portalApi } from '@/api'
import { Button } from '@/components/Button'
import { Alert } from '@/components/Typography'
import type { BroadcastResult, PushState } from '@/domain/types'

/**
 * Broadcast, for the owner.
 *
 * Sits on the Event tab because it is an event-wide action rather than a door-side
 * one, and because it is owner-only in the same way the rest of that tab is.
 *
 * THE HARD PART IS NOT SENDING. IT IS BEING HONEST ABOUT WHO GOT IT.
 *
 * Push is a best-effort channel and pretending otherwise is how an owner ends up
 * believing forty people were told when four were. The result panel therefore reports
 * the four numbers separately — delivered, pruned, failed, total — rather than a
 * cheerful "sent". `pruned` in particular is not a failure at all: those are devices
 * the browser itself has declared gone, and deleting them makes every later send
 * faster. Showing it as an error would train the owner to ignore the line that matters.
 */

/** VAPID's payload ceiling, minus room for the envelope. Mirrors the server's copy. */
const TITLE_MAX = 80
const BODY_MAX = 240

export function AnnouncementPanel() {
  const [state, setState] = useState<PushState | null>(null)
  const [loading, setLoading] = useState(true)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [result, setResult] = useState<BroadcastResult | null>(null)

  const read = useCallback(async () => {
    try {
      setState(await portalApi.getPushState())
    } catch {
      // A failed read leaves `state` null, which renders the same "cannot send"
      // panel. Guessing here would invite the owner to compose something that
      // cannot be delivered.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  if (loading) return null

  if (state !== null && !state.configured) {
    return (
      <section className="border-2 border-swiss-ink p-6">
        <h2 className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
          Announcements
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-content-muted">
          Notifications are not configured on this deployment. Set the VAPID keys in the
          environment and they will appear here.
        </p>
      </section>
    )
  }

  const overTitle = title.length > TITLE_MAX
  const overBody = body.length > BODY_MAX
  const ready = title.trim() !== '' && body.trim() !== '' && !overTitle && !overBody

  async function send() {
    if (!ready || sending) return
    setSending(true)
    setProblem(null)
    setResult(null)
    try {
      const outcome = await portalApi.adminBroadcast({
        title: title.trim(),
        body: body.trim(),
      })
      setResult(outcome)
      // Cleared only after a confirmed send. Losing a composed message because the
      // network blipped is the kind of thing that makes somebody retype a message
      // four times at a door.
      setTitle('')
      setBody('')
      void read()
    } catch (cause) {
      setProblem(
        cause instanceof Error ? cause.message : 'Could not send that announcement.',
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="border-2 border-swiss-ink p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
          Announcements
        </h2>
        {state !== null ? (
          <p className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            {state.subscribers} device{state.subscribers === 1 ? '' : 's'} listening
          </p>
        ) : null}
      </div>

      <p className="mt-3 text-sm leading-relaxed text-content-muted">
        Goes to every attendee who turned notifications on — on their phone, whether or
        not they have this open. The most recent one is also shown on their dashboard, so
        people who declined still see it.
      </p>

      {problem !== null ? (
        <div className="mt-5">
          <Alert>{problem}</Alert>
        </div>
      ) : null}

      <div className="mt-5 flex flex-col gap-4">
        <label className="block">
          <span className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
            Subject
          </span>
          <input
            type="text"
            value={title}
            maxLength={TITLE_MAX + 20}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Lunch is being served"
            className="mt-2 w-full border-2 border-swiss-ink bg-swiss-paper px-3 py-3 text-sm text-swiss-ink outline-none focus:border-swiss-accent-text"
          />
          {overTitle ? (
            <span className="mt-1 block text-2xs font-medium text-content-muted">
              {(TITLE_MAX - title.length).toString()} characters too long.
            </span>
          ) : null}
        </label>

        <label className="block">
          <span className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
            Message
          </span>
          <textarea
            value={body}
            rows={3}
            maxLength={BODY_MAX + 20}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Main hall, ground floor. Bring your badge."
            className="mt-2 w-full resize-y border-2 border-swiss-ink bg-swiss-paper px-3 py-3 text-sm text-swiss-ink outline-none focus:border-swiss-accent-text"
          />
          {overBody ? (
            <span className="mt-1 block text-2xs font-medium text-content-muted">
              {(BODY_MAX - body.length).toString()} characters too long.
            </span>
          ) : null}
        </label>

        <Button variant="primary" size="lg" onClick={() => void send()} disabled={!ready} loading={sending}>
          {sending ? 'Sending' : 'Send to everyone'}
        </Button>
      </div>

      {result !== null ? (
        <div className="mt-6 border-l-4 border-swiss-ink bg-swiss-muted p-4">
          <p className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
            Sent
          </p>
          <p className="mt-2 text-sm leading-relaxed text-content-muted">
            {result.sent} of {result.total} device{result.total === 1 ? '' : 's'} received
            it.
          </p>

          {/*
            Pruning is reported, and deliberately not dressed as a problem.

            Those devices told us they were gone — the browser expired them, or the user
            cleared site data. Deleting the row is the fix, not a fault, and the owner
            needs to see it because it is why the subscriber count drops on its own.
          */}
          {result.pruned > 0 ? (
            <p className="mt-1 text-2xs font-medium leading-relaxed text-content-muted">
              {result.pruned} stale device{result.pruned === 1 ? '' : 's'} removed — those
              browsers had already cancelled.
            </p>
          ) : null}

          {/*
            This is the one that needs action. A non-zero here means devices that still
            exist did not get the message, and on the day that is worth knowing before
            the next announcement rather than after.
          */}
          {result.failed > 0 ? (
            <p className="mt-1 text-2xs font-bold uppercase tracking-[0.15em] text-swiss-ink">
              {result.failed} failed — worth resending.
            </p>
          ) : null}

          {result.total === 0 ? (
            <p className="mt-2 text-2xs font-medium leading-relaxed text-content-muted">
              Nobody has turned notifications on yet. It is saved and will show on their
              dashboard when they next open it.
            </p>
          ) : null}
        </div>
      ) : null}

      {state?.latest ? (
        <p className="mt-4 text-2xs font-medium leading-relaxed text-content-muted">
          Last sent: &ldquo;{state.latest.title}&rdquo;
        </p>
      ) : null}
    </section>
  )
}