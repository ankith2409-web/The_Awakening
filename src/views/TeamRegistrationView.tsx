import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { Announcement, EventMasthead } from '@/components/EventMasthead'
import { EventMark } from '@/components/EventMark'
import { Skeleton } from '@/components/Skeleton'
import { SiteFooter } from '@/components/SiteFooter'
import { WhatsAppJoin } from '@/components/WhatsAppJoin'
import { isValidSen, normaliseSen, phoneProblem } from '@/domain/phone'
import { normaliseEmail, emailProblem } from '@/domain/email'
import { nameProblem } from '@/domain/name'
import { portalApi } from '@/api'
import { eventChanged } from '@/auth/liveEvent'
import { TEAM_SIZE } from '@/domain/types'
import type { EventInfo, TeamRegistration } from '@/domain/types'

/*
  How often the page re-reads the event.

  Ten seconds, same as the check-in page and for the same reason: the only thing
  that changes during an event is which day is open, and the only action anybody
  takes about that here is nothing at all. Teams register whenever they are ready.
*/

const EVENT_POLL_MS = 10_000

/**
 * How many teammates there are, the leader not counting.
 *
 * `TEAM_SIZE - 1`, read rather than written, because a team of three is a fact
 * about the challenge and not a fact about this form. Writing `2` here would be one
 * more place to be wrong on the day, and this form cannot be tested against the
 * server without shipping.
 */
const MATES = TEAM_SIZE - 1

/** One teammate's two fields. */
interface Mate {
  name: string
  sen: string
}

const BLANK_MATE: Mate = { name: '', sen: '' }

/** A shared "no error" pair, so the lookup above has something to fall back to. */
const EMPTY_FIELD_ERRORS: { name?: string; sen?: string } = Object.freeze({})

/**
 * An error to show for a field, or nothing.
 *
 * `touched` is passed IN rather than closed over. As a closure over component state
 * it was a new function on every render, so the `useMemo` that called it had to
 * either list it as a dependency — which changes every render, which makes the
 * memo pointless — or leave it out and be wrong on the render where `touched`
 * changed. A parameter has no identity to track.
 *
 * The rule it encodes is that only a field the student has actually LEFT is worth
 * complaining about. Marking "enter a valid SEN" under a box they have not reached
 * yet is noise that teaches them to ignore red.
 */
function touchedError(
  touched: Record<string, boolean>,
  field: string,
  value: string,
  message: string | null,
): string | undefined {
  return touched[field] && value !== '' ? (message ?? undefined) : undefined
}

/**
 * The team registration page.
 *
 * A SEPARATE PORTAL FROM CHECK-IN, and reached by its own QR, because the two
 * answer different questions on different days. Attendance is per person per day;
 * a team registers once, for the challenge, and the leader is the only person the
 * chapter ever corresponds with. Merging them would put a team leader in the door
 * list once per member and turn the export into a mixture of two unrelated things.
 *
 * NO ACCCOUNT. Same reasoning as check-in: the student scans a poster and that is
 * the whole interaction.
 *
 * THE VALIDATORS ARE THE SERVER'S, RUN WHILE YOU TYPE.
 *
 * Same courtesy as the check-in page. `test:errors` asserts the client and server
 * copies agree, so the message a leader reads mid-typing is the message the server
 * would have sent — and it arrives before they have finished the form rather than
 * after.
 *
 * WHICH FIELD IS FOCUSED FIRST
 *
 * The team name. Unlike the check-in page, where the SEN is the one field everybody
 * knows for certain, here the leader is assembling this on a laptop with three
 * people dictating, and the name of the team is the thing they all agree on first.
 * Everything after it is a person, and people need a second to think.
 */
export function TeamRegistrationView() {
  const [event, setEvent] = useState<EventInfo | null>(null)
  const [eventFailed, setEventFailed] = useState(false)

  const [teamName, setTeamName] = useState('')
  const [leaderName, setLeaderName] = useState('')
  const [leaderEmail, setLeaderEmail] = useState('')
  const [leaderPhone, setLeaderPhone] = useState('')
  const [leaderSen, setLeaderSen] = useState('')
  const [mates, setMates] = useState<Mate[]>(Array.from({ length: MATES }, () => ({ ...BLANK_MATE })))

  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<TeamRegistration | null>(null)

  /*
    The refusal, so it can be brought into view and focused.

    Both halves are needed and neither is enough. Scrolling alone leaves the
    message on screen but not focused, so a screen-reader user is told nothing and a
    keyboard user's next Tab goes somewhere else. Focusing alone scrolls the
    element to the top of the viewport on some browsers, which on a long form
    throws away the reader's place.

    `scrollIntoView` is `block: 'nearest'` rather than the default `start`: this
    form is taller than a phone screen, and a message that has scrolled the team
    name and the leader's block off the top is no more findable than the one that
    was never visible.
  */
  const problemRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (problem === null) return
    const node = problemRef.current
    if (node === null) return
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    node.focus({ preventScroll: true })
  }, [problem])

  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const firstRef = useRef<HTMLInputElement>(null)

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
    if (done === null) firstRef.current?.focus()
  }, [done])

  /*
    Typing is shaped rather than refused afterwards.

    A phone is digits; nobody has ever typed a letter into a phone field meaning to.
    An email is lowercased because the server lowercases it anyway and comparing in
    one case is cheaper than explaining that case does not matter. The SEN is
    uppercased for the same reason as everywhere else in this portal.
  */
  const typePhone = (raw: string) => setLeaderPhone(raw.replace(/\D/g, '').slice(0, 10))
  const typeEmail = (raw: string) => setLeaderEmail(normaliseEmail(raw).slice(0, 254))
  const typeSen = (raw: string) => setLeaderSen(normaliseSen(raw).slice(0, 16))

  const setMate = (index: number, patch: Partial<Mate>) =>
    setMates((current) => current.map((mate, i) => (i === index ? { ...mate, ...patch } : mate)))

  const errors = useMemo(() => {
    const mateErrors = mates.map((mate, index) => ({
      name: touchedError(touched, `mate-${index}-name`, mate.name, nameProblem(mate.name)),
      sen: touchedError(
        touched,
        `mate-${index}-sen`,
        mate.sen,
        isValidSen(mate.sen) ? null : 'Enter the SEN printed on your college ID.',
      ),
    }))

    return {
      teamName: touchedError(touched, 'teamName', teamName, teamNameProblem(teamName)),
      leaderName: touchedError(touched, 'leaderName', leaderName, nameProblem(leaderName)),
      leaderEmail: touchedError(touched, 'leaderEmail', leaderEmail, emailProblem(leaderEmail)),
      leaderPhone: touchedError(touched, 'leaderPhone', leaderPhone, phoneProblem(leaderPhone)),
      leaderSen: touchedError(
        touched,
        'leaderSen',
        leaderSen,
        isValidSen(leaderSen) ? null : 'Enter the SEN printed on your college ID.',
      ),
      mates: mateErrors,
    }
  }, [leaderEmail, leaderName, leaderPhone, leaderSen, mates, teamName, touched])

  /*
    `errors.mates[index]`, read safely.

    `mates` and the mapped `errors.mates` are built from the same array in the same
    render, so the index is always in range and this can never actually be missing.
    But it is `undefined` by the type, and the alternative — a non-null assertion —
    is a claim with nothing behind it. Reading through `?? EMPTY_ERRORS` costs one
    object and cannot be wrong.
  */
  const mateErrorAt = (index: number): { name?: string; sen?: string } =>
    errors.mates[index] ?? EMPTY_FIELD_ERRORS

  /*
    The SEN uniqueness check, in the browser.

    A leader typing three SENs into two boxes is the single most likely mistake on
    this form, and it is caught by the server only after a round trip. Checking it
    here costs nothing and turns a refusal into a field-level correction.
  */
  const allSens = useMemo(
    () => [leaderSen, ...mates.map((m) => m.sen)].filter((s) => s !== ''),
    [leaderSen, mates],
  )
  const clash = useMemo(() => {
    const seen = new Set<string>()
    for (const sen of allSens) {
      const key = sen.toUpperCase()
      if (seen.has(key)) return sen
      seen.add(key)
    }
    return null
  }, [allSens])

  const ready =
    teamNameProblem(teamName) === null &&
    nameProblem(leaderName) === null &&
    emailProblem(leaderEmail) === null &&
    phoneProblem(leaderPhone) === null &&
    isValidSen(leaderSen) &&
    mates.every((m) => nameProblem(m.name) === null && isValidSen(m.sen)) &&
    clash === null

  const submit = useCallback(
    async (event_: React.FormEvent) => {
      event_.preventDefault()
      if (busy || !ready) return

      setBusy(true)
      setProblem(null)
      try {
        setDone(
          await portalApi.registerTeam({
            name: teamName,
            leaderName,
            leaderEmail,
            leaderPhone,
            leaderSen,
            members: mates.map((m) => ({ name: m.name, sen: m.sen })),
          }),
        )
      } catch (cause) {
        /*
          Never "we could not reach the server".

          This one action records a team for the whole event. A leader whose submit
          failed because the hall has no signal has to know whether it landed, and
          the only honest answer is the one that tells them to.
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
    /*
      `clash` is deliberately NOT a dependency here.

      The body never reads it. What the duplicate check changes is `ready`, which is
      already in the list — so a clash re-derives `ready`, `ready` re-derives this
      callback, and the guard `if (!ready) return` is what actually stops the
      submit. Listing `clash` as well would mean two dependencies that move together.
    */
    [busy, leaderEmail, leaderName, leaderPhone, leaderSen, mates, ready, teamName],
  )

  if (done !== null) return <TeamRegistered result={done} />

  /*
    THE EVENT BEING SHUT IS THE ONLY STATE THIS FORM HAS.

    Unlike the check-in page there is no per-day version of this, and there is no
    reason to build one: teams are formed once, for the challenge, so "closed" means
    closed. The button an organiser pressed is the same one either way.
  */
  const eventShut = event !== null && event.registrationMode === 'closed'

  return (
    <main className="flex min-h-dvh flex-col">
      <div className="flex-1 px-5 py-10 sm:px-8 sm:py-14">
        <div className="mx-auto max-w-2xl">
          <header className="mb-8 flex items-center justify-between gap-4">
            <EventMark />
            <span className="shrink-0 border-2 border-swiss-ink px-3 py-2 font-mono text-2xs font-bold tracking-[0.2em] text-swiss-ink">
              {TEAM_SIZE} MEMBERS
            </span>
          </header>

          {eventFailed ? (
            <div className="mb-6 border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
              The event details could not be loaded. You can still register below.
            </div>
          ) : event !== null ? (
            <EventMasthead
              eyebrow="Team registration"
              title={event.name}
              event={event}
              tone="compact"
            />
          ) : (
            <div className="mb-6 flex flex-col gap-3" aria-hidden="true">
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          <section className="border-2 border-swiss-ink">
            <header className="border-b-2 border-swiss-ink bg-swiss-ink px-5 py-3.5">
              <h2 className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
                {eventShut ? 'Registration closed' : 'Register your team'}
              </h2>
            </header>

            {eventShut ? (
              /*
                The form is not rendered at all, not rendered disabled.

                A disabled nine-field form is a wall. Somebody scanning the poster
                still has to be told the answer before they start typing, and the
                cheapest honest version of that is no form and a sentence.
              */
              <div className="p-6">
                <p className="border-l-4 border-swiss-ink bg-swiss-muted p-4 text-lg font-black uppercase leading-snug tracking-[0.05em] text-swiss-ink">
                  Team registration is closed
                </p>
                <p className="mt-5 text-2xs font-medium leading-relaxed text-content-muted">
                  The event has been closed by an organiser, so no more teams can be
                  added and nobody can be marked in. If you have only just arrived,
                  speak to them.
                </p>
              </div>
            ) : (
            <form onSubmit={submit} noValidate className="flex flex-col gap-6 p-6">
              {/*
                NO ERROR BANNER AT THE TOP.

                This form is nine fields long and the submit button is at the bottom
                of it. A refusal rendered above the first field is roughly a screen
                and a half away from the button the reader just pressed, and the
                whole surface does not visibly change — so a leader whose SEN was
                already on a team pressed the button, saw nothing happen, and had to
                scroll back up to find out why. That is the same failure as no
                message at all, with extra steps.

                The refusal now renders directly above the button, where the eye
                already is, and is scrolled into view on arrival. See `problemRef`.
              */}

              <Field
                ref={firstRef}
                label="Team name"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, teamName: true }))}
                autoCapitalize="words"
                spellCheck={false}
                required
                maxLength={60}
                error={errors.teamName}
              />

              {/*
                THE LEADER, IN THEIR OWN BOX.

                A ruled sub-block rather than four fields in a column. The leader is
                the only person the chapter corresponds with — the pass goes to them
                and nowhere else — and a form that shows that as an indentation
                rather than a border makes the reader work out which of the seven
                boxes is them.
              */}
              <fieldset className="flex flex-col gap-6 border-l-4 border-swiss-ink pl-5">
                <legend className="sr-only">Team leader</legend>
                <p className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text">
                  Team leader
                </p>

                <Field
                  label="Leader's name"
                  value={leaderName}
                  onChange={(e) => setLeaderName(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, leaderName: true }))}
                  autoComplete="name"
                  autoCapitalize="words"
                  spellCheck={false}
                  required
                  maxLength={60}
                  error={errors.leaderName}
                />

                <Field
                  label="Leader's email"
                  value={leaderEmail}
                  onChange={(e) => typeEmail(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, leaderEmail: true }))}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  spellCheck={false}
                  placeholder="name@example.com"
                  required
                  maxLength={254}
                  error={errors.leaderEmail}
                  hint="The pass is emailed here, and to nowhere else."
                />

                <Field
                  label="Leader's phone"
                  value={leaderPhone}
                  onChange={(e) => typePhone(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, leaderPhone: true }))}
                  inputMode="numeric"
                  autoComplete="tel-national"
                  placeholder="9876543210"
                  required
                  maxLength={10}
                  error={errors.leaderPhone}
                  hint="A 10-digit mobile number."
                  className="font-mono"
                />

                <Field
                  label="Leader's SEN"
                  value={leaderSen}
                  onChange={(e) => typeSen(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, leaderSen: true }))}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="A866175000012"
                  required
                  maxLength={16}
                  error={errors.leaderSen}
                  hint="As printed on your college ID."
                  className="font-mono uppercase"
                />
              </fieldset>

              {/*
                THE TEAMMATES.

                One numbered block each rather than a repeating grid, because there
                are only two of them and a grid would give every field the same
                weight as the leader's — which is the opposite of how this form is
                used.
              */}
              {mates.map((mate, index) => (
                <fieldset key={index} className="flex flex-col gap-4 border-l-4 border-swiss-ink/35 pl-5">
                  <legend className="sr-only">{`Teammate ${index + 1}`}</legend>
                  <p className="text-2xs font-bold uppercase tracking-[0.25em] text-content-muted">
                    Teammate {index + 1}
                  </p>

                  <Field
                    label="Name"
                    value={mate.name}
                    onChange={(e) => setMate(index, { name: e.target.value })}
                    onBlur={() => setTouched((t) => ({ ...t, [`mate-${index}-name`]: true }))}
                    autoComplete="off"
                    autoCapitalize="words"
                    spellCheck={false}
                    required
                    maxLength={60}
                    error={mateErrorAt(index).name}
                  />

                  <Field
                    label="SEN"
                    value={mate.sen}
                    onChange={(e) => setMate(index, { sen: normaliseSen(e.target.value).slice(0, 16) })}
                    onBlur={() => setTouched((t) => ({ ...t, [`mate-${index}-sen`]: true }))}
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="A866175000012"
                    required
                    maxLength={16}
                    error={mateErrorAt(index).sen}
                    hint="As printed on their college ID."
                    className="font-mono uppercase"
                  />
                </fieldset>
              ))}

              {/*
                THE DUPLICATE SEN, SAID WHERE IT IS.

                Every SEN must be different — not just because the database refuses
                it, but because a leader who typed the same number twice will hand
                one member a pass with the wrong name on it and never find out.
              */}
              {clash !== null ? (
                <p
                  role="alert"
                  className="border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
                >
                  {clash} is entered more than once. Each member needs their own SEN.
                </p>
              ) : null}

              {/*
                THE SERVER'S REFUSAL, WHERE THE READER IS LOOKING.

                Directly above the button rather than at the top of the form, and
                `role="alert"` so it is announced rather than only shown.

                It is rendered in the same place as the duplicate-SEN warning
                because they answer the same question — "why did nothing happen?" —
                and a form that answers a refusal in one place and a validation
                fault in another makes the reader check both before pressing again.
              */}
              {problem !== null ? (
                <p
                  ref={problemRef}
                  role="alert"
                  tabIndex={-1}
                  className="border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink focus:outline-none"
                >
                  {problem}
                </p>
              ) : null}

              <Button type="submit" variant="accent" size="lg" loading={busy} disabled={!ready}>
                {busy ? 'Registering' : 'Register team'}
              </Button>

              <p className="border-t border-swiss-ink/15 pt-4 text-2xs font-medium leading-relaxed text-content-muted">
                The pass is emailed to the team leader only. Each member still checks
                in at the door on their own SEN.
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
 * What a leader sees once the team is in.
 *
 * The same shape as the check-in confirmation: confirm, give the record, then get
 * out of the way. There is no button on it except the one thing worth offering,
 * which is the group.
 */
function TeamRegistered({ result }: { result: TeamRegistration }) {
  const [event, setEvent] = useState<EventInfo | null>(null)

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

  return (
    <main className="flex min-h-dvh flex-col">
      <header className="border-b-2 border-swiss-ink">
        <div className="h-1.5 bg-swiss-accent" aria-hidden="true" />
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <EventMark />
          <p className="shrink-0 font-mono text-2xs font-bold tracking-[0.2em] text-content-muted">
            {result.members.length} MEMBERS
          </p>
        </div>
      </header>

      <div className="flex-1 px-5 py-10 sm:px-8 sm:py-14">
        <div className="mx-auto max-w-3xl">
          <Announcement event={event} />

          <EventMasthead
            eyebrow="Team registered"
            title={result.team.name}
            event={event}
            facts={[
              ['Leader', result.team.leaderName],
              ['Email', result.team.leaderEmail],
              ['Phone', result.team.leaderPhone],
            ]}
          />

          <section className="mt-10">
            <h2 className="flex items-center gap-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text">
              <span aria-hidden="true" className="h-[3px] w-12 bg-swiss-accent-text" />
              Members
            </h2>

            <ul className="mt-5 flex flex-col border-2 border-swiss-ink">
              {result.members.map((member) => (
                <li
                  key={member.sen}
                  className="flex flex-col gap-1 border-b border-swiss-ink/15 bg-swiss-muted px-4 py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
                >
                  <div>
                    <p className="text-sm font-black tracking-tight text-swiss-ink">
                      {member.name}
                    </p>
                    {member.isLeader ? (
                      <p className="mt-0.5 text-2xs font-bold uppercase tracking-[0.15em] text-swiss-accent-text">
                        Team leader
                      </p>
                    ) : null}
                  </div>
                  <p className="font-mono text-sm tracking-tight text-swiss-ink">{member.sen}</p>
                </li>
              ))}
            </ul>
          </section>

          <p className="mt-8 border-l-4 border-swiss-accent-text bg-swiss-muted p-5 text-sm font-medium leading-relaxed text-swiss-ink">
            A pass is on its way to {result.team.leaderEmail}. Every member still
            checks in at the door on their own SEN.
          </p>

          <WhatsAppJoin />
        </div>
      </div>

      <SiteFooter />
    </main>
  )
}

/**
 * The team name's own rule, kept separate from `nameProblem`.
 *
 * A team name is not a person's name: "The Sleep Deprived", "404" and "Team Rocket"
 * are all perfectly good team names and all of them fail a rule written for humans.
 * So this only refuses what would actually break the pass — nothing typed, or
 * something too long for a database column and an email subject line.
 */
function teamNameProblem(raw: string): string | null {
  const value = raw.trim()
  if (value === '') return 'Enter a team name.'
  if (value.length > 60) return `That is ${value.length} characters. Keep it under 60.`
  return null
}
