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

const STATUS_STYLE: Record<AgendaItem['status'], string> = {
  done: 'bg-swiss-ink text-swiss-paper border-swiss-ink',
  live: 'bg-swiss-accent-text text-swiss-paper border-swiss-accent-text',
  upcoming: 'bg-swiss-paper text-swiss-ink border-swiss-ink',
}

/**
 * Event status column.
 *
 * The phase is the headline; the agenda beneath it is a definition list so the
 * time, title and speaker stay programmatically associated rather than being
 * loose text.
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

  const done = event.agenda.filter((item) => item.status === 'done').length
  const progress = event.agenda.length === 0 ? 0 : Math.round((done / event.agenda.length) * 100)

  // Agenda grouped by day, preserving order. A two-day programme rendered as
  // one flat list would not say which session falls on the 14th and which on
  // the 15th.
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

      {/* Progress: hard-edged segments, no gradients. */}
      <div className="border-b-2 border-swiss-ink p-6">
        <div className="flex items-baseline justify-between">
          <span className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
            Programme complete
          </span>
          <span className="font-mono text-sm font-black text-swiss-ink">{progress}%</span>
        </div>
        <div
          className="mt-3 flex gap-1"
          role="img"
          aria-label={`${progress} percent of the programme complete`}
        >
          {event.agenda.map((item) => (
            <div
              key={item.id}
              className={[
                'h-2 flex-1 border-2 border-swiss-ink',
                item.status === 'done' ? 'bg-swiss-ink' : 'bg-swiss-paper',
                item.status === 'live' ? 'bg-swiss-accent-text' : '',
              ].join(' ')}
            />
          ))}
        </div>
        {typeof checkedInCount === 'number' ? (
          <p className="mt-3 text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            {checkedInCount} checked in · {event.capacity} capacity
          </p>
        ) : null}
      </div>

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
                  'motion-stagger flex items-start gap-4 p-4',
                  index > 0 ? 'border-t border-swiss-ink/15' : '',
                ].join(' ')}
              >
                <time className="w-14 shrink-0 pt-0.5 font-mono text-2xs font-bold text-swiss-ink">
                  {item.startsAt}
                </time>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold leading-snug tracking-tight text-swiss-ink">
                    {item.title}
                  </p>
                  <p className="mt-1 text-2xs font-medium text-content-muted">
                    {item.speaker} · {item.room}
                  </p>
                </div>
                <span
                  className={[
                    'shrink-0 border-2 px-2 py-0.5 text-2xs font-bold uppercase tracking-[0.15em]',
                    STATUS_STYLE[item.status],
                  ].join(' ')}
                >
                  {item.status}
                </span>
              </li>
            ))}
          </ol>
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
