import { useCallback, useState } from 'react'
import type { EventInfo, RegistrationMode } from '@/domain/types'

/**
 * Open, restrict, or close registration.
 *
 * Three states rather than one switch, because they are three different decisions
 * made at three different moments, and a single toggle cannot tell them apart:
 *
 *   open        where the portal belongs for the weeks of sign-ups
 *   restricted  a guest list has been uploaded and is now the answer
 *   closed      capacity reached, or the event is over
 *
 * The middle one is meaningless with no list uploaded — it would present an empty
 * door with nothing explaining why — so it is disabled until there is something to
 * be on. The third is the state a boolean could never express at all, and it is
 * exactly the state somebody needs on the morning once the room is full.
 *
 * Each option states its consequence in words. This control decides whether a
 * student can walk in, and a lit-up position in a row of three is not something to
 * infer at a door.
 */
const MODES: {
  id: RegistrationMode
  label: string
  consequence: string
}[] = [
  { id: 'open', label: 'Open', consequence: 'Anyone can register' },
  {
    id: 'restricted',
    label: 'Guest list',
    consequence: 'Only students on the uploaded list',
  },
  { id: 'closed', label: 'Closed', consequence: 'Nobody can register' },
]

export function RegistrationSwitch({
  event,
  rosterCount,
  onChanged,
}: {
  /** Null while the portal is still loading; nothing is shown until it lands. */
  event: EventInfo | null
  /** Read from the roster rather than the event, so the two cannot disagree. */
  rosterCount: number
  onChanged: (mode: RegistrationMode) => void
}) {
  const [busy, setBusy] = useState<RegistrationMode | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const current = event?.registrationMode ?? 'open'

  const choose = useCallback(
    (mode: RegistrationMode) => {
      if (mode === current || busy !== null) return
      setBusy(mode)
      setProblem(null)
      // The provider owns the write and the resulting state, so the switch, the
      // guest list panel and the registration form all settle from one response
      // rather than three panels each holding their own optimistic guess.
      onChanged(mode)
      // Cleared on the next tick. The provider surfaces real failures through its
      // own error banner; this local flag only exists to stop a double tap.
      window.setTimeout(() => setBusy(null), 250)
    },
    [busy, current, onChanged],
  )

  return (
    <section className="border-2 border-swiss-ink">
      <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-4 py-3 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-paper sm:px-6">
        Registration
      </h2>

      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <p className="text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
          {event === null
            ? 'Checking…'
            : current === 'open'
              ? 'Open — anyone can register'
              : current === 'restricted'
                ? `Guest list — ${rosterCount} student${rosterCount === 1 ? '' : 's'} can register`
                : 'Closed — nobody can register'}
        </p>

        {/*
          A column, not a row.

          Three options each carrying a sentence do not fit side by side on a 360px
          phone, and squeezing them in is what turns a control like this into
          something somebody taps the wrong part of.
        */}
        <div
          role="group"
          aria-label="Who can register"
          className="flex flex-col gap-px bg-swiss-ink sm:flex-row"
        >
          {MODES.map((option) => {
            const selected = current === option.id
            const unavailable = option.id === 'restricted' && rosterCount === 0

            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                disabled={busy !== null || unavailable}
                onClick={() => choose(option.id)}
                className={[
                  'flex min-h-14 w-full flex-1 cursor-pointer flex-col items-start gap-1 px-4 py-3 text-left',
                  'transition-colors duration-150 ease-linear',
                  unavailable ? 'cursor-not-allowed opacity-45' : '',
                  selected
                    ? 'bg-swiss-accent-text text-swiss-paper'
                    : 'bg-swiss-paper text-swiss-ink hover:bg-swiss-muted',
                ].join(' ')}
              >
                <span className="text-sm font-bold uppercase tracking-[0.15em]">
                  {option.label}
                  {busy === option.id ? ' …' : ''}
                </span>
                <span className="text-2xs font-medium tracking-normal opacity-90">
                  {unavailable ? 'Upload a guest list first' : option.consequence}
                </span>
              </button>
            )
          })}
        </div>

        {problem !== null ? (
          <p
            role="alert"
            className="border-l-4 border-swiss-accent-text bg-swiss-muted p-3 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
          >
            {problem}
          </p>
        ) : null}

        {current === 'closed' ? (
          <p className="text-2xs font-medium leading-relaxed text-content-muted">
            People who already registered can still log in and show their pass. You
            can also add somebody by hand below.
          </p>
        ) : null}
      </div>
    </section>
  )
}