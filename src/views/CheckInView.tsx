import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { EventMark } from '@/components/EventMark'
import { SiteFooter } from '@/components/SiteFooter'
import { formatEventDateRange } from '@/lib/eventDate'
import { portalApi } from '@/api'
import { eventChanged } from '@/auth/liveEvent'
import type { CheckInOutcome, EventInfo } from '@/domain/types'

/*
  How often the page re-reads the event.

  Ten seconds. The only thing on this page that changes during an event is which
  day is open, and the only thing anybody here does about that is arrive at the
  wall and press a button — a student standing in front of a poster for half an
  hour is not refreshing.

  Long enough not to drain a phone in a room with no signal, short enough that an
  organiser who opens day two is not looking at a stale "closed" for the rest of
  the morning.
*/
const EVENT_POLL_MS = 10_000

/**
 * The check-in page. The whole attendee surface.
 *
 * REACHED BY SCANNING THE POSTER, so it is the first thing anybody sees and the
 * only thing they do. There is no account behind it, no second page to reach and
 * nothing to sign in to afterwards.
 *
 * WHY NO HERO
 *
 * There was one, and it was the thing that made people wait. A visitor who had
 * already scanned a QR to get here had told the room they were here; making them
 * scroll past a title to reach the box that records it was friction with no
 * information in it. The event's name and dates are still on the page, above the
 * box, because somebody who opened the link by hand should still know what they
 * opened.
 *
 * THE THREE FIELDS ARE THE SAME THREE THE GATE USED TO ASK FOR
 *
 * Name, phone, SEN. Nothing new, so nobody has to read a rule on the day. The
 * SEN is the only one that is genuinely load-bearing — it is what the export
 * lists and what identifies the person — but the other two are what an organiser
 * expects to see next to it, and dropping them would leave a list of SENs with no
 * names attached.
 *
 * WHAT HAPPENS AFTERWARDS IS A CONFIRMATION, NOT A NEW PAGE
 *
 * The student has been marked. Sending them somewhere else to be told so invites
 * them to start a second interaction they do not need, and the most likely one is
 * "check in again", which is at best redundant and at worst a double mark.
 */

type Stage = 'form' | 'done'

export function CheckInView() {
  const [event, setEvent] = useState<EventInfo | null>(null)
  const [eventFailed, setEventFailed] = useState(false)

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [sen, setSen] = useState('')

  const [stage, setStage] = useState<Stage>('form')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<CheckInOutcome | null>(null)

  /*
    The SEN field is what somebody types fastest and gets wrong most often, so it
    is focused on arrival rather than first-tapped. A student who arrived by
    scanning has nothing else to do first, and putting the cursor in the field they
    are most likely to fill in is the whole difference between finishing in three
    seconds and hunting for the right box.
  */
  const senRef = useRef<HTMLInputElement>(null)

  /*
    The event, polled rather than pushed.

    There is no attendee provider to hold it any more — it existed to keep a
    signed-in student's dashboard current, and there are no signed-in students.
    Re-fetching is a little more traffic than a push and rather less machinery,
    which is the right way round for a page whose whole job is one POST.

    The signature check means an unchanged event does not re-render, so this costs
    one comparison every ten seconds and nothing else.
  */
  useEffect(() => {
    let alive = true

    const read = async () => {
      try {
        const next = await portalApi.getEvent()
        if (!alive) return
        setEvent((current) => (eventChanged(current, next) ? next : current))
        setEventFailed(false)
      } catch {
        if (alive) setEventFailed(true)
      }
    }

    void read()
    const timer = setInterval(() => void read(), EVENT_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (stage === 'form') senRef.current?.focus()
  }, [stage])

  const submit = useCallback(
    async (event_: React.FormEvent) => {
      event_.preventDefault()
      if (busy) return

      setBusy(true)
      setProblem(null)
      try {
        const result = await portalApi.checkIn({ name, phone, sen })
        setOutcome(result)
        setStage('done')
      } catch (cause) {
        setProblem(cause instanceof Error ? cause.message : 'Could not record that. Try again.')
      } finally {
        setBusy(false)
      }
    },
    [busy, name, phone, sen],
  )

  /* -- the confirmation ------------------------------------------------------ */

  if (stage === 'done' && outcome !== null) {
    return (
      <main className="flex min-h-dvh flex-col">
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
          <EventMark className="mb-10" />

          <div className="w-full max-w-md border-2 border-swiss-ink">
            <div className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-4">
              <h1 className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
                {outcome.alreadyMarked ? 'Already marked' : 'You are marked in'}
              </h1>
            </div>

            <div className="flex flex-col gap-5 p-6">
              <div className="border-l-4 border-swiss-accent-text bg-swiss-muted p-4">
                <p className="text-sm font-black tracking-tight text-swiss-ink">
                  {outcome.name}
                </p>
                <p className="mt-1 font-mono text-2xs font-bold text-content-muted">
                  {outcome.sen}
                </p>
              </div>

              {/*
                "Already marked" is NOT a failure and must not read like one.

                Somebody who tapped twice, or whose first tap timed out on a bad
                connection and who retried, has still been to the event exactly
                once. Telling them the day is closed — or showing an error — would
                send them hunting for somebody who can fix it, and there is
                nothing to fix.
              */}
              <p className="text-2xs font-medium leading-relaxed text-content-muted">
                {outcome.alreadyMarked ? (
                  <>
                    You were already marked for day {outcome.day}. Nothing more to do.
                  </>
                ) : (
                  <>
                    Day {outcome.day} of {outcome.dayState.totalDays}. Show this screen
                    at the door if you need to.
                  </>
                )}
              </p>

              {/*
                The one thing a student might still get wrong is their own name,
                and this is the last moment they can say so. It costs one sentence
                and it is the difference between a register that reads correctly
                and one that reads "Ankth".
              */}
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setStage('form')
                  setOutcome(null)
                }}
              >
                That is not my name
              </Button>
            </div>
          </div>
        </div>

        <SiteFooter />
      </main>
    )
  }

  /* -- the box --------------------------------------------------------------- */

  const closed =
    event !== null && event.lockedDays.includes(event.activeDay)

  return (
    <main className="flex min-h-dvh flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <EventMark className="mb-8" />

        {/*
          The event, in three lines, above the box.

          Not decoration. Somebody who typed the link rather than scanning it needs
          to know what they opened before typing their name into it, and an
          organiser standing at the door needs to be able to confirm the room is the
          right room.
        */}
        {event !== null ? (
          <div className="mb-8 w-full max-w-md border-2 border-swiss-ink">
            <dl className="divide-y divide-swiss-ink/20">
              {[
                ['Event', event.name],
                ['Date', formatEventDateRange(event.date, event.endDate)],
                ['Venue', event.venue],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline gap-4 px-5 py-3">
                  <dt className="w-20 shrink-0 text-2xs font-bold uppercase tracking-[0.2em] text-content-muted">
                    {label}
                  </dt>
                  <dd className="text-sm font-bold text-swiss-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : eventFailed ? (
          <p className="mb-8 w-full max-w-md border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
            The event details could not be loaded. You can still check in below.
          </p>
        ) : null}

        <div className="w-full max-w-md border-2 border-swiss-ink">
          <div className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-4">
            <h1 className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
              Check in
            </h1>
          </div>

          {/*
            A closed day says so IN THE BOX, not as an error after a submit.

            An organiser closing day one is not a fault and the student has done
            nothing wrong. Burying it behind a failed request would leave somebody
            standing at a wall wondering whether they did something wrong, when the
            answer is simply that check-in for that day is over.
          */}
          {closed ? (
            <div className="p-6">
              <p className="border-l-4 border-swiss-ink bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
                Check-in for day {event!.activeDay} is closed.
              </p>
              <p className="mt-4 text-2xs font-medium leading-relaxed text-content-muted">
                Attendance for this day is no longer being recorded. Speak to an
                organiser if you have just arrived.
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-5 p-6">
              <p className="text-2xs font-medium leading-relaxed text-content-muted">
                Enter your name, phone number and SEN. This records your
                attendance for day {event?.activeDay ?? 1}.
              </p>

              <Field
                label="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
                maxLength={60}
              />
              <Field
                label="Phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="numeric"
                autoComplete="tel"
                required
                maxLength={10}
              />
              <Field
                ref={senRef}
                label="SEN"
                value={sen}
                onChange={(e) => setSen(e.target.value)}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                placeholder="A866175000012"
                required
                maxLength={16}
                hint="A letter followed by 12 digits."
              />

              {problem !== null ? (
                <p
                  role="alert"
                  className="border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
                >
                  {problem}
                </p>
              ) : null}

              <Button type="submit" variant="accent" size="lg" loading={busy}>
                {busy ? 'Recording' : 'Mark me in'}
              </Button>

              {/*
                The re-check, in the open.

                Somebody who taps twice must not be told they are marked twice, and
                somebody whose first tap failed must not be left wondering. The
                unique index makes the second one a no-op; this says so.
              */}
              <p className="text-2xs font-medium leading-relaxed text-content-muted">
                Already pressed this? It is safe — you can only be marked once for a
                day.
              </p>
            </form>
          )}
        </div>
      </div>

      <SiteFooter />
    </main>
  )
}