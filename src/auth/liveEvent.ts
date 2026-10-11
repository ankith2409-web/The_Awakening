import type { EventInfo } from '@/domain/types'

/**
 * How often the portal re-reads the event.
 *
 * Five seconds. This is the gap between an organiser pressing a switch and somebody
 * else seeing it, on a phone, at a door — and the reason it is not smaller is that
 * the change being waited for is a human decision made minutes apart from the next
 * one, not a stream. Five seconds is well inside the window in which a person is
 * still looking at the screen.
 *
 * It is not on by default everywhere. Each provider decides whether polling is
 * appropriate for its own state, and both skip entirely while the tab is hidden.
 */
export const LIVE_POLL_MS = 5_000

/**
 * A comparable summary of everything the portal actually reads off an event.
 *
 * Built field by field, in a fixed order, rather than `JSON.stringify(event)`.
 *
 * That is deliberate. The poll exists to decide "has anything changed?", and the
 * only cost of getting it wrong is a wasted re-render every five seconds for as long
 * as the tab is open. `JSON.stringify` would compare key insertion order as well as
 * content, so any response assembled in a different order — a server deploy, a mock
 * seeded differently — would look permanently different and the dashboard would
 * re-render on every tick, for ever, with nothing on screen changing.
 *
 * A named list is also the answer to "what does this poll actually keep fresh?",
 * which is not otherwise a question the code can answer.
 */
export function eventSignature(event: EventInfo): string {
  return [
    event.phase,
    event.registrationMode,
    event.rosterCount,
    event.activeDay,
    event.calendarDay,
    event.totalDays,
    event.dayOverridden ? '1' : '0',
    /*
      The pin itself, not just whether there is one.

      The day picker in the admin portal reads `dayOverride` to decide which button is
      pressed, so it needs its own comparison. `activeDay` alone is not enough: moving
      the pin from one day to another on a day when the calendar already resolves to
      the second changes neither `activeDay` nor `dayOverridden`, and every other device
      would keep showing the old day as pinned until somebody reloaded.

      Found by the completeness assertion in `test:live`, which is exactly what it was
      written to find: the same omission as the announcement, in the surface most likely
      to be read mid-event.
    */
    event.dayOverride === null ? 'null' : String(event.dayOverride),
    event.lockedDays.join(','),
    event.name,
    event.tagline,
    event.organiser,
    event.organiserHost ?? '',
    event.venue,
    event.city,
    event.date,
    event.endDate ?? '',
    String(event.capacity),
    /*
      The newest announcement, by ID.

      By ID rather than by title and body, because only the ID decides whether there is
      anything new to show. Two messages with identical wording are still two messages,
      and the second one is exactly the case the fallback exists for.

      This field was MISSING when the announcement feature was added, and the effect
      was that the banner only ever appeared on a fresh page load: the poll fetched
      the new announcement, compared signatures, found no difference, and discarded it.
      For every attendee who declined the push permission -- the people this fallback
      is the only channel for -- the message never arrived at all unless they reloaded.

      test:live now asserts the signature covers every field on EventInfo, so this
      list cannot silently go stale again.
    */
    event.announcement?.id ?? '',
    event.agenda
      .map((item) => `${item.id}:${item.title}:${item.speaker}:${item.day}:${item.startsAt ?? ''}`)
      .join('|'),
  ].join('~')
}

/**
 * True when two event payloads differ in any way the portal can show.
 *
 * Used to make a poll free when nothing has changed, which matters because the
 * alternative is re-rendering the whole dashboard every five seconds for the whole
 * time somebody has it open.
 */
export function eventChanged(current: EventInfo | null, next: EventInfo): boolean {
  if (current === null) return true
  return eventSignature(current) !== eventSignature(next)
}