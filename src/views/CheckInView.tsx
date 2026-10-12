import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { Announcement, EventMasthead, FactGrid, Programme } from '@/components/EventMasthead'
import { EventMark } from '@/components/EventMark'
import { Skeleton } from '@/components/Skeleton'
import { SiteFooter } from '@/components/SiteFooter'
import { WhatsAppJoin } from '@/components/WhatsAppJoin'
import { formatEventDateRange } from '@/lib/eventDate'
import { isValidSen, normaliseSen, phoneProblem } from '@/domain/phone'
import { nameProblem } from '@/domain/name'
import { portalApi } from '@/api'
import { eventChanged } from '@/auth/liveEvent'
import type { CheckInOutcome, EventInfo } from '@/domain/types'

/*
  How often the page re-reads the event.

  Ten seconds. The only thing on this page that changes during an event is which
  day is open, and the only thing anybody here does about that is arrive at a
  wall and press a button — a student standing in front of a poster for half an
  hour is not refreshing.

  Long enough not to drain a phone in a room with no signal, short enough that an
  organiser who opens day two is not looking at a stale "closed" for the rest of
  the morning.
*/
const EVENT_POLL_MS = 10_000

/**
 * The check-in page, and then the event.
 *
 * REACHED BY SCANNING A POSTER, so it is the first thing anybody sees and the
 * first thing they do. No account behind it, nothing to sign in to, no second
 * page to find afterwards.
 *
 * WHAT HAPPENS AFTERWARDS
 *
 * The confirmation carries the whole event: title, dates, venue, host, the
 * owner's announcement if there is one, and the programme grouped by day. That is
 * the information the old post-login page gave somebody, minus the pass — and it
 * earns its place here for a better reason than habit: a student who has just
 * checked in is standing in the room, and "what is on today" is the question they
 * are about to ask somebody. Answering it on their phone is one fewer person to
 * interrupt.
 *
 * VALIDATION HAPPENS WHILE YOU TYPE
 *
 * The server already refuses a bad name, phone or SEN with copy naming the actual
 * fault. That copy arrives as a banner, at the bottom, after a round trip — the
 * worst possible moment to be told the third field is wrong, because by then the
 * student is hunting for the mistake rather than reading the message.
 *
 * So the same validators run here as they type. The server check is not removed:
 * this is a courtesy, and the server is still the authority.
 *
 * WHERE THE CURSOR GOES
 *
 * The SEN. It is the field somebody knows for certain and types fastest; a name
 * has variants and a phone has to be remembered. Somebody who arrived by scanning
 * has nothing to do first.
 */
export function CheckInView() {
  const [event, setEvent] = useState<EventInfo | null>(null)
  const [eventFailed, setEventFailed] = useState(false)

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [sen, setSen] = useState('')

  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<CheckInOutcome | null>(null)

  /*
    Only a field the student has actually left is worth complaining about.

    Marking "Enter a valid SEN" under a field they have not reached yet is noise
    that teaches them to ignore red. An error appears only once the field has been
    touched and left non-empty — which is exactly when a warning is worth reading.
  */
  const [touched, setTouched] = useState({ name: false, phone: false, sen: false })

  const senRef = useRef<HTMLInputElement>(null)

  /*
    The event, polled rather than pushed.

    There is no attendee provider to hold it any more — it existed to keep a
    signed-in student's dashboard current, and there are no signed-in students.
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
    if (outcome === null) senRef.current?.focus()
  }, [outcome])

  /*
    The fields shape what is typed rather than refusing it afterwards.

    A phone number is digits. Nobody has ever typed a letter into a phone field
    meaning to, and stripping them means the number is right without the student
    ever reading a message about it. The SEN is uppercased because every SEN this
    portal accepts starts with a capital, and comparing in one case is cheaper
    than explaining that case does not matter.
  */
  const typePhone = (raw: string) => setPhone(raw.replace(/\D/g, '').slice(0, 10))
  const typeSen = (raw: string) => setSen(normaliseSen(raw).slice(0, 16))

  const errors = useMemo(() => {
    const show = (field: keyof typeof touched, value: string, message: string | null) =>
      touched[field] && value !== '' ? (message ?? undefined) : undefined

    return {
      name: show('name', name, nameProblem(name)),
      phone: show('phone', phone, phoneProblem(phone)),
      /*
            The SEN rule is deliberately looser than "a letter and twelve digits":
            `SEN202601` is a real SEN on this event's own register, and telling
            somebody their ID was wrong because it did not match the pattern
            printed under the box would be the worst possible first impression.

            So the message names the field and gives an example, and the hint says
            where to look rather than describing a rule the portal does not hold
            itself to.
          */
          sen: show('sen', sen, isValidSen(sen) ? null : 'Enter the SEN printed on your college ID.'),
    }
  }, [name, phone, sen, touched])

  const ready = nameProblem(name) === null && phoneProblem(phone) === null && isValidSen(sen)

  const submit = useCallback(
    async (event_: React.FormEvent) => {
      event_.preventDefault()
      if (busy || !ready) return

      setBusy(true)
      setProblem(null)
      try {
        setOutcome(await portalApi.checkIn({ name, phone, sen }))
      } catch (cause) {
        /*
          Never "we could not reach the server".

          This one action records somebody's attendance. A student whose tap failed
          because the room has no signal has to know whether it landed, because if
          it did not they have to press it again — and the only honest answer is the
          one that tells them to.
        */
        setProblem(
          cause instanceof Error
            ? cause.message
            : 'That did not go through. Check your connection and try once more.',
        )
      } finally {
        setBusy(false)
      }
    },
    [busy, name, phone, ready, sen],
  )

  if (outcome !== null) return <CheckedIn outcome={outcome} />

  const closed = event !== null && event.lockedDays.includes(event.activeDay)
  const activeDay = event?.activeDay ?? 1
  const totalDays = event?.totalDays ?? 1

  return (
    <main className="flex min-h-dvh flex-col">
      <div className="flex-1 px-5 py-10 sm:px-8 sm:py-14">
        <div className="mx-auto max-w-2xl">
          <header className="mb-8 flex items-center justify-between gap-4">
            <EventMark />
            {!closed ? (
              <span className="shrink-0 border-2 border-swiss-ink px-3 py-2 font-mono text-2xs font-bold tracking-[0.2em] text-swiss-ink">
                DAY {activeDay}/{totalDays}
              </span>
            ) : null}
          </header>

          {/*
            The event identity, at the compact size.

            The full display treatment — the clamped nine-vw title — is used on
            the confirmation, where the student has finished typing and the page is
            something to read. Above three input fields it is a different thing
            entirely: it is a reason to scroll before reaching the box, which is
            what the old page did.
          */}
          {eventFailed ? (
            <div className="mb-6 border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
              The event details could not be loaded. You can still check in below.
            </div>
          ) : event !== null ? (
            <EventMasthead eyebrow="Attendee portal" title={event.name} event={event} tone="compact" />
          ) : (
            <div className="mb-6 flex flex-col gap-3" aria-hidden="true">
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          <section className="border-2 border-swiss-ink">
            <header className="flex items-center justify-between gap-4 border-b-2 border-swiss-ink bg-swiss-ink px-5 py-3.5">
              <h2 className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
                {closed ? 'Check-in closed' : 'Check in'}
              </h2>
            </header>

            {/*
              A closed day says so IN THE BOX, before anything is typed.

              An organiser closing a day is not a fault and the student has done
              nothing wrong. Burying it behind a failed request would leave somebody
              standing at a wall wondering whether they had done something wrong,
              when the answer is that check-in for that day is over.
            */}
            {closed ? (
              <div className="p-6">
                <p className="border-l-4 border-swiss-ink bg-swiss-muted p-4 text-lg font-black uppercase leading-snug tracking-[0.05em] text-swiss-ink">
                  Check-in for day {activeDay} is closed
                </p>
                <p className="mt-5 text-2xs font-medium leading-relaxed text-content-muted">
                  Attendance for this day is no longer being recorded. If you have
                  only just arrived, speak to an organiser.
                </p>
              </div>
            ) : (
              <form onSubmit={submit} noValidate className="flex flex-col gap-6 p-6">
                {problem !== null ? (
                  <p
                    role="alert"
                    className="border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
                  >
                    {problem}
                  </p>
                ) : null}

                <Field
                  label="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  autoComplete="name"
                  autoCapitalize="words"
                  spellCheck={false}
                  required
                  maxLength={60}
                  error={errors.name}
                />

                <Field
                  label="Phone"
                  value={phone}
                  onChange={(e) => typePhone(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
                  inputMode="numeric"
                  autoComplete="tel-national"
                  placeholder="9876543210"
                  required
                  maxLength={10}
                  error={errors.phone}
                  hint="A 10-digit mobile number."
                  className="font-mono"
                />

                <Field
                  ref={senRef}
                  label="SEN"
                  value={sen}
                  onChange={(e) => typeSen(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, sen: true }))}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="A866175000012"
                  required
                  maxLength={16}
                  error={errors.sen}
                  hint="As printed on your college ID."
                  className="font-mono uppercase"
                />

                <Button
                  type="submit"
                  variant="accent"
                  size="lg"
                  loading={busy}
                  disabled={!ready}
                >
                  {busy ? 'Recording' : 'Mark me in'}
                </Button>

                {/*
                  The re-check, said once and plainly.

                  Somebody who taps twice must not be told they are marked twice,
                  and somebody whose first tap timed out must not be left wondering
                  whether it landed. The unique index makes the second a no-op; this
                  is what stops them pressing a third time looking worried.
                */}
                <p className="border-t border-swiss-ink/15 pt-4 text-2xs font-medium leading-relaxed text-content-muted">
                  Already pressed this? It is safe — you can only be marked once for a
                  day.
                </p>
              </form>
            )}
          </section>
        </div>
      </div>

      <SiteFooter />
    </main>
  )
}

/**
 * The event, and the confirmation.
 *
 * Deliberately has NO BUTTON on it.
 *
 * A confirmation with an action invites a second interaction nobody needs. The
 * plausible ones are "check in again" — redundant at best and a double mark at
 * worst — and correcting a name just typed, which the register cannot be changed
 * by anyway. Offering either would be offering something that does not work.
 *
 * So it confirms, gives the record, and then becomes the thing a student reads
 * while they wait for a session to start.
 */
function CheckedIn({ outcome }: { outcome: CheckInOutcome }) {
  const [event, setEvent] = useState<EventInfo | null>(null)

  /*
    The event is re-read here rather than passed down.

    It is the same request the form page made, it is public, and re-reading means
    the confirmation shows the day state as it is NOW rather than as it was a
    round trip ago — which matters, because the organiser may have opened day two
    while somebody was filling in the form.
  */
  useEffect(() => {
    let alive = true
    portalApi
      .getEvent()
      .then((next) => {
        if (alive) setEvent(next)
      })
      .catch(() => {
        /* The confirmation is still worth showing without it. */
      })
    return () => {
      alive = false
    }
  }, [])

  const already = outcome.alreadyMarked

  return (
    <main className="flex min-h-dvh flex-col">
      <header className="border-b-2 border-swiss-ink">
        <div className="h-1.5 bg-swiss-accent" aria-hidden="true" />
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <EventMark />
          <p className="shrink-0 font-mono text-2xs font-bold tracking-[0.2em] text-content-muted">
            DAY {outcome.day}/{outcome.dayState.totalDays}
          </p>
        </div>
      </header>

      <div className="flex-1 px-5 py-10 sm:px-8 sm:py-14">
        <div className="mx-auto max-w-5xl">
          <Announcement event={event} />

          {/*
            "Already marked" is NOT a failure and must not read like one.

            Somebody who tapped twice, or whose first tap timed out and who retried,
            has still been to the event exactly once. Giving that an error treatment
            would send them hunting for somebody who can fix it, and there is
            nothing to fix.
          */}
          <EventMasthead
            eyebrow={already ? 'Already recorded' : 'Attendance recorded'}
            title={already ? 'Already marked in' : 'You are marked in'}
            event={event}
            facts={[
              ['Name', outcome.name],
              ['SEN', outcome.sen],
            ]}
          />

          {/*
            What to do next, which is nothing — and saying so is the whole job of
            this line. Silence here is what leaves somebody standing in the queue
            wondering whether to go in.
          */}
          <p className="border-l-4 border-swiss-accent-text bg-swiss-muted p-5 text-sm font-medium leading-relaxed text-swiss-ink">
            {already ? (
              <>
                You were already marked for day {outcome.day}. Nothing more to do —
                you are on the list.
              </>
            ) : (
              <>
                Day {outcome.day} of {outcome.dayState.totalDays} is recorded against
                your SEN. Show this screen at the door if anyone asks.
              </>
            )}
          </p>

          <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <Programme event={event} />
            </div>

            {/*
              The event's own identity, repeated on the right on a wide screen.

              On a phone it stacks under the programme, which is correct — a
              student reading on a 390px screen gets the programme first, because
              that is what they are waiting for.
            */}
            <aside className="lg:col-span-5">
              <h2 className="flex items-center gap-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text">
                <span aria-hidden="true" className="h-[3px] w-12 bg-swiss-accent-text" />
                The event
              </h2>

              {event !== null ? (
                <FactGrid
                  className="mt-5"
                  facts={[
                    ['Dates', formatEventDateRange(event.date, event.endDate)],
                    ['Venue', event.venue],
                    ['Hosted by', event.organiserHost ?? event.organiser],
                    ['Run by', event.organiser],
                  ]}
                />
              ) : (
                <div className="mt-5 flex flex-col gap-2" aria-hidden="true">
                  <Skeleton className="h-16 w-full" />
                </div>
              )}

              {event !== null && event.tagline ? (
                <p className="mt-4 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                  {event.tagline}
                </p>
              ) : null}
            </aside>
          </div>

          {/*
            The group, last.

            After the programme and the event facts rather than above them: it is
            the only thing here that is a request rather than information, and a
            request that interrupts the reading of a schedule is a request some
            people skip.
          */}
          <WhatsAppJoin />
        </div>
      </div>

      <SiteFooter />
    </main>
  )
}