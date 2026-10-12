import type { ReactNode } from 'react'
import { formatEventDateRange } from '@/lib/eventDate'
import type { EventInfo } from '@/domain/types'

/**
 * A grid of label/value cells with 1px rules between them.
 *
 * Exported because three facts in two columns and five in three both leave
 * unfilled slots, and an unfilled slot in this treatment is not blank — it is the
 * ink background showing through as a solid black rectangle mid-page, which reads
 * as a rendering fault. The shortfall is computed and padded, once, here, so no
 * caller has to remember.
 *
 * `columns` is derived from the row count rather than passed in, so a different
 * number of facts cannot reintroduce the gap.
 */
export function FactGrid({
  facts,
  className = '',
}: {
  readonly facts: readonly (readonly [string, string])[]
  readonly className?: string
}) {
  if (facts.length === 0) return null

  const columns = facts.length > 4 ? 3 : 2
  const remainder = facts.length % columns
  const fillers = remainder === 0 ? 0 : columns - remainder

  return (
    <dl
      className={`grid gap-px border-2 border-swiss-ink bg-swiss-ink ${
        columns === 3 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2'
      } ${className}`}
    >
      {facts.map(([term, value]) => (
        <div key={term} className="bg-swiss-muted px-4 py-3">
          <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            {term}
          </dt>
          <dd className="mt-1 break-words text-sm font-black tracking-tight text-swiss-ink">
            {value}
          </dd>
        </div>
      ))}

      {Array.from({ length: fillers }, (_, i) => (
        /* Keyed by index on purpose: identical, and they hold nothing. */
        <div key={`filler-${i}`} aria-hidden="true" className="bg-swiss-muted" />
      ))}
    </dl>
  )
}

/**
 * The event masthead: an eyebrow, a rule, a title, and a grid of facts.
 *
 * This is the shape the landing page and the old dashboard both used, extracted
 * so the check-in page and the confirmation can share it rather than each
 * inventing their own. Two screens that have to agree about what the event is
 * should read it from one place, not from two blocks of markup that drift.
 *
 * `facts` is passed in rather than derived, because the two screens want
 * different rows: the check-in page shows the event, and the confirmation shows
 * the event PLUS the person who just checked in. Deriving both here would mean
 * one of them gets facts it does not want.
 */
export function EventMasthead({
  eyebrow,
  title,
  event,
  facts,
  tone = 'full',
}: {
  eyebrow: string
  title: string
  event: EventInfo | null
  /** Rows for the grid. The event's own facts go first, in this order. */
  facts?: readonly (readonly [string, string])[]
  /**
   * `full` is the display treatment — the clamped display size and the accent
   * rule, for a screen the reader has finished with. `compact` is the same
   * structure at phone sizes, for a screen with a form still to fill in.
   *
   * Not a variant for variety: a nine-vw title above three input fields is the
   * exact thing that made the old page make people scroll.
   */
  tone?: 'full' | 'compact'
}) {
  const compact = tone === 'compact'

  const eventFacts: (readonly [string, string])[] = event
    ? [
        ['Date', formatEventDateRange(event.date, event.endDate)],
        ['Venue', event.venue],
        ...(event.organiserHost ? ([['Hosted by', event.organiserHost]] as const) : []),
      ]
    : []

  return (
    <header className={compact ? 'mb-6' : 'mb-8'}>
      <p className="flex items-center gap-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text">
        <span aria-hidden="true" className="h-[3px] w-12 bg-swiss-accent-text" />
        {eyebrow}
      </p>

      <h1
        className={
          compact
            ? 'mt-3 text-[clamp(1.5rem,7vw,2.25rem)] font-black uppercase leading-[0.9] tracking-tighter text-swiss-ink'
            : 'mt-4 text-[clamp(1.9rem,9vw,3.75rem)] font-black uppercase leading-[0.88] tracking-tighter text-swiss-ink'
        }
      >
        {title}
      </h1>

      {event !== null && event.tagline ? (
        <p className="mt-3 text-sm font-medium tracking-tight text-content-muted">
          {event.tagline}
        </p>
      ) : null}

      <FactGrid facts={[...eventFacts, ...(facts ?? [])]} />
    </header>
  )
}

/**
 * The programme.
 *
 * Grouped by day, because the event is two days and an undifferentiated list of
 * nine rows is a list nobody can use. Each day is headed with its calendar date
 * rather than "Day 1" alone, so a student in the room can tell at a glance
 * whether they are looking at today's list.
 *
 * NO TIMES AND NO ROOMS. There is no timetable and there are no rooms, and
 * inventing them would be worse than showing none — somebody would plan their
 * morning around a 09:30 that does not exist.
 */
export function Programme({ event }: { event: EventInfo | null }) {
  if (event === null || event.agenda.length === 0) return null

  const days = [...new Set(event.agenda.map((item) => item.day))].sort((a, b) => a - b)

  return (
    <section aria-labelledby="programme-heading">
      <h2
        id="programme-heading"
        className="flex items-center gap-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text"
      >
        <span aria-hidden="true" className="h-[3px] w-12 bg-swiss-accent-text" />
        Programme
      </h2>

      <div className="mt-5 flex flex-col gap-8">
        {days.map((day) => (
          <div key={day}>
            {days.length > 1 ? (
              <h3 className="border-b-2 border-swiss-ink pb-2 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
                Day {day} · {dateForDay(event.date, day)}
              </h3>
            ) : null}

            <ol className="mt-3 flex flex-col">
              {event.agenda
                .filter((item) => item.day === day)
                .map((item) => (
                  <li
                    key={item.id}
                    className="border-b border-swiss-ink/15 py-3 first:pt-0 last:border-b-0"
                  >
                    <p className="text-sm font-black tracking-tight text-swiss-ink">
                      {item.title}
                    </p>
                    <p className="mt-0.5 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                      {item.speaker}
                    </p>
                  </li>
                ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  )
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * `2026-10-13` plus a day number -> `14 October 2026`.
 *
 * Parsed and formatted in UTC throughout. `new Date('2026-10-13')` is UTC
 * midnight, so reading it back with local getters anywhere west of UTC yields
 * the 12th — and a programme headed with the wrong date is worse than no date.
 */
function dateForDay(startIso: string, day: number): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startIso)
  if (!parts) return ''

  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])))
  date.setUTCDate(date.getUTCDate() + (day - 1))

  const month = MONTHS[date.getUTCMonth()]
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`
}

/**
 * The owner's most recent announcement, or nothing.
 *
 * The one genuinely time-critical thing on the page: a room change exists because
 * something changed today, and it belongs above everything rather than in a
 * column. Renders NOTHING when there is no announcement, rather than an empty
 * box — a panel with nothing in it reads as something that failed to load.
 */
export function Announcement({ event }: { event: EventInfo | null }): ReactNode {
  const announcement = event?.announcement ?? null
  if (announcement === null) return null

  return (
    <aside
      role="status"
      className="mb-8 border-2 border-swiss-ink bg-swiss-muted p-5"
    >
      <p className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text">
        Announcement
      </p>
      <p className="mt-2 text-sm font-black tracking-tight text-swiss-ink">
        {announcement.title}
      </p>
      <p className="mt-1 text-2xs font-medium leading-relaxed text-content-muted">
        {announcement.body}
      </p>
    </aside>
  )
}