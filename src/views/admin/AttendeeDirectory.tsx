import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useAdmin } from '@/auth/contexts'
import { stagger } from '@/lib/motion'
import { VALIDATORS } from '@/auth/validation'
import { matchesAttendeeQuery } from '@/domain/attendeeSearch'
import { Button } from '@/components/Button'
import { PasswordField } from '@/components/Field'
import { Skeleton } from '@/components/Skeleton'
import { formatPhone, normaliseSen } from '@/domain/phone'
import type { Attendee } from '@/domain/types'

/** Cap the rendered rows so a 500-person roster stays scrollable on a phone. */
const PAGE = 60

/**
 * The registration desk: find an attendee, set their password.
 *
 * This panel is the entire password-recovery story. There used to be a public
 * "forgot password" page, and it was the most serious weakness in the portal —
 * no OTP, no email, no security question, so anyone who knew a phone number
 * could take over that account and walk in with the attendee's pass. It was
 * also under active probing in production. Deleting it is the fix; this panel
 * is what replaces it, and the reason the attendee portal has no such link is
 * that recovery is a conversation with a person.
 *
 * Three decisions worth stating, because each of them could reasonably have
 * gone the other way:
 *
 *   Searched by SEN, not by phone. The SEN is printed on the badge and already
 *   identifies the person at the gate. Asking a stranger to dictate a phone
 *   number gets it wrong; asking for the number on the pass in their hand does
 *   not.
 *
 *   The admin types the password, the attendee does not. An admin-mediated flow
 *   where the attendee picks their own credential still needs to deliver it to
 *   them somehow — which means another channel, and another thing to get wrong.
 *   "Set it and read it out loud" has no channel to fail.
 *
 *   Every change revokes that attendee's sessions. A password change that
 *   leaves old sessions alive has not locked anyone out, which defeats the
 *   point of changing a password.
 *
 * No edit and no delete here, matching the attendance panel: this is a lookup
 * and a single deliberate credential change, nothing else.
 */
export function AttendeeDirectory() {
  /*
    Aliased rather than used as `setAttendeePassword`. The provider's method name
    reads as a React state setter, and that is the wrong mental model at this
    call site: this does not set local state, it asks the server to change
    someone else's credential, and the `change` in the name is what tells the
    reader that.
  */
  const {
    attendees,
    attendance,
    loadingData,
    clearError,
    setAttendeePassword: changePasswordFor,
  } = useAdmin()

  const [query, setQuery] = useState('')
  const [openSen, setOpenSen] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  /** Set on success, keyed by SEN, and left up until the next search. */
  const [done, setDone] = useState<string | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  /*
    One row may be open at a time. Two inline password forms on screen is how
    the wrong attendee gets the wrong password, and there is no workflow that
    needs both.
  */
  const open = useCallback((sen: string) => {
    clearError()
    setOpenSen(sen)
    setPassword('')
    setProblem(null)
    setDone(null)
  }, [clearError])

  const close = useCallback(() => {
    setOpenSen(null)
    setPassword('')
    setProblem(null)
  }, [])

  /*
    Focus the password box as the row opens. The staff member's hands are already
    on the keyboard — they have just read the number off a badge — so typing
    straight in is the whole interaction.

    An effect rather than `requestAnimationFrame`, and that is not a style
    preference. rAF is tied to paint, and paint does not happen in a backgrounded
    tab: opening a row while the organiser has switched away left focus on the
    body when they came back, so the first characters of the new password went
    nowhere. Effects run after commit whether or not anything is on screen.

    Keyed on `openSen` rather than on a boolean, so reopening the same row still
    moves focus — a staff member who cancels and reopens is starting again.
  */
  useEffect(() => {
    if (openSen === null) return
    passwordRef.current?.focus()
  }, [openSen])

  /*
    Which days this attendee is marked for.

    A Set of day numbers rather than a single boolean. It used to be a bare "in"
    derived from whether any record existed at all, which was correct while
    attendance was once-in-a-lifetime and is now wrong twice over: it cannot say
    which day, and it would show somebody who came only to day one as present for
    an event that has a second day still to run.

    The badge reads "D1" / "D1 D2" — short enough for a row, and unambiguous once
    the column has a heading. The fuller wording is in the `title`.
  */
  const markedDays = useMemo(() => {
    const byAttendee = new Map<string, Set<number>>()
    for (const record of attendance) {
      const days = byAttendee.get(record.attendeeId) ?? new Set<number>()
      days.add(record.day)
      byAttendee.set(record.attendeeId, days)
    }
    return byAttendee
  }, [attendance])

  const matches = useMemo(() => matchesAttendeeQuery(attendees, query), [attendees, query])

  /*
    A plain function, not a `useCallback`.

    It is passed to exactly one form and that form is not memoised, so a stable
    identity buys nothing here. The dependency list it would need is also the
    kind that quietly rots: the moment someone adds a state read to the body
    they have to remember it, and the list is the only thing standing between a
    stale closure and setting the wrong attendee's password.
  */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (openSen === null) return

    const found = VALIDATORS.password(password)
    if (found) {
      setProblem(found)
      return
    }

    setProblem(null)
    setSubmitting(true)
    try {
      const result = await changePasswordFor(openSen, password)
      if (result === null) {
        /*
          The reason is already in the banner. The form is deliberately left
          open with the text intact: the failure this actually happens for is a
          mistyped SEN, and staff should correct the number and resubmit rather
          than retype the password they just chose.
        */
        return
      }
      setDone(result.sen)
      setOpenSen(null)
      setPassword('')
    } finally {
      setSubmitting(false)
    }
  }

  /*
    `done` is cleared from the search input's own onChange rather than by an
    effect on `query`. Same behaviour, no second pass over the render, and no
    window where a stale confirmation is still on screen for a frame.
  */

  if (loadingData && attendees.length === 0) return <Skeleton className="h-64 w-full" />

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 border-2 border-swiss-ink p-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex-1">
          <label
            htmlFor="desk-search"
            className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink"
          >
            Find attendee
          </label>
          <input
            id="desk-search"
            type="search"
            value={query}
            autoComplete="off"
            placeholder="Name, SEN or phone"
            onChange={(event) => {
              setQuery(event.target.value)
              setDone(null)
            }}
            className={[
              'mt-2 h-14 w-full border-2 border-swiss-ink bg-swiss-paper px-4',
              'font-medium text-swiss-ink placeholder:text-neutral-400',
              'transition-colors duration-150 ease-linear',
              'focus:border-swiss-accent-text focus:outline-none',
            ].join(' ')}
          />
        </div>

        <p className="shrink-0 text-2xs font-bold uppercase tracking-[0.2em] text-content-muted sm:text-right">
          {matches.length === attendees.length
            ? `${attendees.length} registered`
            : `${matches.length} of ${attendees.length}`}
        </p>
      </header>

      {/*
        Read out the point of this panel before an operator opens it. Someone
        looking for a password reset is looking for the thing they were told to
        look for, and a bare "Set password" button invites the assumption that
        it emails a link — which would be a false promise.
      */}
      <p className="border-l-4 border-swiss-ink bg-swiss-muted p-4 text-2xs font-medium leading-relaxed text-content-muted">
        <span className="font-bold uppercase tracking-[0.2em] text-swiss-ink">
          Password recovery
        </span>{' '}
        is handled here and nowhere else. Set the new password with the attendee
        watching, then read it back to them. They cannot change it themselves,
        and any existing session on their device is ended by this.
      </p>

      {matches.length === 0 ? (
        <p
          role="status"
          className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted"
        >
          No registered attendee matches that
        </p>
      ) : (
        <ul className="flex flex-col border-t-2 border-swiss-ink">
          {matches.slice(0, PAGE).map((person, index) => (
            <DirectoryRow
              key={person.id}
              person={person}
              index={index}
              markedDays={daysFor(markedDays.get(person.id))}
              isOpen={openSen === normaliseSen(person.sen)}
              justChanged={done === normaliseSen(person.sen)}
              submitting={submitting}
              problem={problem}
              password={password}
              passwordRef={passwordRef}
              onOpen={() => open(normaliseSen(person.sen))}
              onClose={close}
              onPasswordChange={(value) => {
                setPassword(value)
                if (problem) setProblem(null)
              }}
              onSubmit={submit}
            />
          ))}

          {matches.length > PAGE ? (
            <li className="border-t border-swiss-ink/15 py-4 text-2xs font-bold uppercase tracking-[0.2em] text-content-muted">
              Showing the first {PAGE} — narrow the search to reach the rest
            </li>
          ) : null}
        </ul>
      )}
    </div>
  )
}

/** Sorted day numbers for one attendee, or an empty list. */
function daysFor(days: Set<number> | undefined): number[] {
  return days === undefined ? [] : [...days].sort((a, b) => a - b)
}

/** One attendee, and the inline form that sets their password. */
function DirectoryRow({
  person,
  index,
  markedDays,
  isOpen,
  justChanged,
  submitting,
  problem,
  password,
  passwordRef,
  onOpen,
  onClose,
  onPasswordChange,
  onSubmit,
}: {
  readonly person: Attendee
  readonly index: number
  /** Which days this person is marked for. Empty when not marked at all. */
  readonly markedDays: readonly number[]
  readonly isOpen: boolean
  readonly justChanged: boolean
  readonly submitting: boolean
  readonly problem: string | null
  readonly password: string
  readonly passwordRef: React.RefObject<HTMLInputElement | null>
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onPasswordChange: (value: string) => void
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const sen = normaliseSen(person.sen)

  return (
    <li
      style={stagger(index)}
      className="border-b border-swiss-ink/15"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-lg font-black tracking-tight text-swiss-ink">
            {person.name}
            {/*
              Was a bare "IN". That was ambiguous even before per-day attendance —
              it sat under a masthead reading "OPERATING AS", so it could plausibly be
              read as a session state. Now it names the days, and the title spells
              it out for anyone who has to ask.

              One badge per day rather than "D1 D2" in one: it stays legible at the
              width a row actually has, and the two read as separate facts — which
              they are.
            */}
            {markedDays.map((day) => (
              <span
                key={day}
                title={`Marked present on day ${day}`}
                className="border border-swiss-ink px-2 py-0.5 font-mono text-2xs font-bold uppercase tracking-[0.1em] text-swiss-ink"
              >
                D{day}
              </span>
            ))}
            {justChanged ? (
              <span
                role="status"
                className="motion-scale-in border-2 border-swiss-ink px-2 py-0.5 text-2xs font-bold uppercase tracking-[0.15em] text-swiss-ink"
              >
                Password set
              </span>
            ) : null}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-4 font-mono text-2xs text-content-muted">
            <span>{sen}</span>
            {person.phone ? <span>{formatPhone(person.phone)}</span> : null}
          </p>
        </div>

        {isOpen ? null : (
          <Button variant="secondary" size="md" onClick={onOpen}>
            Set password
          </Button>
        )}
      </div>

      {isOpen ? (
        <form
          onSubmit={onSubmit}
          className="mb-5 flex flex-col gap-4 border-2 border-swiss-ink bg-swiss-muted p-5 sm:flex-row sm:items-start"
        >
          <div className="flex-1">
            <p className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted">
              New password for
            </p>
            <p className="mt-1 text-base font-black tracking-tight text-swiss-ink">
              {person.name}
            </p>
            <p className="font-mono text-2xs text-content-muted">{sen}</p>
          </div>

          <div className="flex-1">
            <PasswordField
              ref={passwordRef}
              label="New password"
              name={`new-password-${person.id}`}
              autoComplete="new-password"
              hint="At least 8 characters, with a letter and a number."
              value={password}
              error={problem ?? undefined}
              onChange={(event) => onPasswordChange(event.target.value)}
            />
          </div>

          <div className="flex gap-3 sm:pt-8">
            <Button type="submit" variant="primary" size="md" loading={submitting}>
              {submitting ? 'Setting' : 'Set it'}
            </Button>
            <Button type="button" variant="secondary" size="md" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  )
}