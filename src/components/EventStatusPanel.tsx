import type { AgendaItem, EventInfo, EventPhase } from '@/domain/types'
import {
  dateForDay,
  formatEventDateRange,
  formatEventDayHeading,
} from '@/lib/eventDate'
import { Skeleton } from './Skeleton'
import { stagger } from '@/lib/motion'

const PHASE_LABEL: Record<EventPhase, string> = {
  registration: 'Registration Open',
  live: 'Live Now',
  completed: 'Completed',
}

/**
 * Event status column.
 *
 * The phase is the headline; the programme beneath it is grouped by day.
 *
 * There is no per-session time, room or status. The programme is what happens,
 * not a timetable: the previous version showed a "Programme complete" bar and a
 * DONE / LIVE / UPCOMING badge per session, both driven by a control an owner
 * would have had to press every few minutes during the event. With that control
 * gone, a bar fed by those flags would sit at 0% all day and a badge would sit
 * at UPCOMING all day — both of which are worse than showing neither.
 */
export function EventStatusPanel({
  event,
  loading,
  checkedInCount,
}: {
  event: EventInfo | null
  loading: boolean
  checkedInCount?: number
}) {
  if (loading) {
    return (
      <Panel title="Event Status" index="03.">
        <Skeleton className="h-40 w-full" />
      </Panel>
    )
  }

  if (!event) {
    return (
      <Panel title="Event Status" index="03.">
        <p role="status" className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-accent-text">
          Event data unavailable
        </p>
      </Panel>
    )
  }

  // Agenda grouped by day, preserving order. A two-day programme rendered as
  // one flat list would not say which session falls on the 13th and which on
  // the 14th.
  const totalDays = new Set(event.agenda.map((item) => item.day ?? 1)).size
  const byDay = new Map<number, AgendaItem[]>()
  for (const item of event.agenda) {
    const day = item.day ?? 1
    const bucket = byDay.get(day)
    if (bucket) bucket.push(item)
    else byDay.set(day, [item])
  }

  return (
    <Panel title="Event Status" index="03.">
      {/* Headline: phase + when + where */}
      <div className="border-b-2 border-swiss-ink p-6">
        <span className="inline-block border-2 border-swiss-ink bg-swiss-ink px-3 py-1 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-paper">
          {PHASE_LABEL[event.phase]}
        </span>

        <h3 className="mt-4 text-2xl font-black uppercase leading-none tracking-tighter text-swiss-ink">
          {event.name}
        </h3>
        {/* Tagline is the sub-line: "AI agents — built by you" */}
        <p className="mt-2 text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
          {event.tagline}
        </p>
        <p className="mt-1 text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
          {event.organiser}
          {event.organiserHost ? ` · ${event.organiserHost}` : ''}
        </p>
        <p className="mt-1 text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
          {event.venue}, {event.city}
        </p>
        <p className="mt-1 font-mono text-sm font-bold text-swiss-ink">
          {formatEventDateRange(event.date, event.endDate)}
        </p>
      </div>

      {/*
        Attendance, not progress.

        This used to be a "Programme complete" bar. It was honest only while
        somebody kept the per-session status flags current, which during a live
        event means pressing a button every few minutes — so in practice it read
        0% on the dashboard of every attendee at the exact moment the programme
        was furthest from 0%.
      */}
      {typeof checkedInCount === 'number' ? (
        <div className="border-b-2 border-swiss-ink p-6">
          <span className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
            Checked in
          </span>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="font-mono text-2xl font-black leading-none text-swiss-ink">
              {checkedInCount}
            </span>
            <span className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
              of {event.capacity} capacity
            </span>
          </div>
        </div>
      ) : null}

      {/*
        Agenda, grouped by day. A day heading appears only when the event
        actually spans more than one — a single-day programme would otherwise
        repeat a redundant date above every session.
      */}
      {[...byDay.entries()].map(([day, items], groupIndex) => (
        <div key={day} className={groupIndex > 0 ? 'border-t-2 border-swiss-ink' : ''}>
          {totalDays > 1 ? (
            <h4 className="bg-swiss-muted px-4 py-2 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-ink">
              {formatEventDayHeading(dateForDay(event.date, day), day, totalDays)}
            </h4>
          ) : null}

          <ol className="flex flex-col">
            {items.map((item, index) => (
              <li
                key={item.id}
                style={stagger(index)}
                className={[
                  'motion-stagger p-4',
                  index > 0 ? 'border-t border-swiss-ink/15' : '',
                ].join(' ')}
              >
                <p className="text-sm font-bold leading-snug tracking-tight text-swiss-ink">
                  {item.title}
                </p>
              </li>
            ))}
          </ol>

          {/*
            Speakers once per day. Both presenters are on both days, so every row
            carries the same string; printed ten times it reads like a fault
            rather than a fact.
          */}
          {items[0] ? (
            <p className="border-t border-swiss-ink/15 px-4 py-2.5 text-2xs font-medium text-content-muted">
              Speakers: {items[0].speaker}
            </p>
          ) : null}
        </div>
      ))}
    </Panel>
  )
}

function Panel({
  title,
  index,
  children,
}: {
  title: string
  index: string
  children: React.ReactNode
}) {
  return (
    <section
      aria-labelledby={`panel-${index}`}
      className="flex flex-col border-2 border-swiss-ink bg-swiss-paper"
    >
      <header className="flex items-baseline justify-between gap-3 border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3">
        <h2
          id={`panel-${index}`}
          className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper"
        >
          {title}
        </h2>
        <span className="font-mono text-2xs font-bold text-swiss-accent-on-dark">{index}</span>
      </header>
      {children}
    </section>
  )
}
