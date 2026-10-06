import { db } from './db.ts'

/**
 * Which day of the event a scan belongs to.
 *
 * The whole per-day attendance feature reduces to one question, and it is answered
 * here, on the server, from the calendar. The client never sends a day.
 *
 * That is the important decision. A day picker in the admin UI sounds friendlier,
 * but it is one control that, left on the wrong setting, files an entire morning's
 * scans under the wrong heading — and nobody notices until the export. Deriving
 * it from the date means there is nothing at the door to get wrong, and the
 * operator's job stays exactly what it was: scan the badge.
 *
 * Two things it has to cope with:
 *
 *   Before the event, and after it. Every test scan ever run against this portal
 *   happens outside the window, so "no day" cannot be the answer — it would mean
 *   the gate is unusable for testing. Before the window resolves to day one, after
 *   it to the last day, which is also what a real organiser means by "we are not
 *   live, just leave it somewhere sensible".
 *
 *   A forced day. `events.day_override` pins the active day regardless of the
 *   date. That is how the day-two path gets tested before it happens, and how an
 *   organiser says "we are running day two's sessions this morning" without
 *   editing a date.
 */

/** The event runs in Bengaluru, which is UTC+05:30 and has no daylight saving. */
const EVENT_TIMEZONE = 'Asia/Kolkata'

export interface EventDayState {
  /** Which day scans are currently recorded against. 1-based. */
  readonly activeDay: number
  /** The day the calendar says it is, even when an override is in force. */
  readonly calendarDay: number
  /** How many days the event has. 1 for a single-day event. */
  readonly totalDays: number
  /**
   * Whether an owner has pinned the day, rather than it coming from the calendar.
   *
   * Surfaced in the UI so nobody has to wonder why the portal thinks it is day
   * one when the calendar says otherwise — that is exactly the confusion a forced
   * day creates if nobody knows it is in force.
   */
  readonly overridden: boolean
  /**
   * Days an owner has closed attendance for.
   *
   * Reported here, from the same read as the active day, so the scan route gets the
   * live day and whether it is open in one query rather than two that could disagree
   * — a scan must never be refused because of a stale second read.
   */
  readonly lockedDays: readonly number[]
}

/*
  Note on the "future days are locked" rule.
  ─────────────────────────────────────────
  It is not a check anywhere, because it does not need to be one.

  The scan endpoint records `activeDay` and nothing else — the client cannot name
  a day, and there is no code path that takes one as input. So the only way to
  record day two is for `activeDay` to be two, which without an override requires
  the calendar to already be on day two.

  On day one, therefore, day two cannot be recorded. Not because something checks,
  but because there is nothing to check. An earlier draft exposed a `canMark(day)`
  predicate for this; it was never called, and having a rule stated in a function
  nobody invokes is worse than having it stated as a property of the design — a
  future change could call it, or believe it was being enforced elsewhere.

  An owner's override is the deliberate exception, in both directions: pinning day
  two on the morning of day one is how you exercise the day-two path before it
  happens, and pinning day one on the morning of day two is how you record a
  scan you missed yesterday.
*/

/**
 * Days spanned by a start date and an optional end date.
 *
 * `end_date` equal to `date` means one day, which is what a single-day event
 * looks like, so the count is never zero and the clamp always has a valid range.
 *
 * `YYYY-MM-DD` only, and it rejects anything else rather than trying to cope.
 *
 * That strictness is a direct response to a real bug: this was called with a
 * Postgres DATE that node-pg had already turned into a JS Date, whose
 * `toString()` is not ISO. `Date.parse` returned NaN, the `Number.isNaN` guard
 * quietly returned 1, and a two-day event presented itself as a one-day one —
 * silently, with every downstream number wrong and nothing reporting it. Taking
 * only the date part of a real Date would have hidden the mistake instead of
 * catching it.
 */
export function totalDaysFor(start: string, end: string | null | undefined): number {
  const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

  if (!CALENDAR_DATE.test(start)) return 1
  if (end !== null && end !== undefined && !CALENDAR_DATE.test(end)) return 1

  const first = Date.parse(`${start}T00:00:00Z`)
  const last = Date.parse(`${end ?? start}T00:00:00Z`)
  if (Number.isNaN(first) || Number.isNaN(last)) return 1
  return Math.max(1, Math.round((last - first) / 86_400_000) + 1)
}

/**
 * The day the calendar says it is, clamped into the event's range.
 *
 * Computed by formatting rather than by arithmetic on a `Date`, because
 * subtracting 86,400,000 ms from a UTC instant is the standard way to land on the
 * wrong local day. `toLocaleDateString` with an explicit time zone asks the
 * runtime what the date actually is in Bengaluru, which is the question being
 * asked.
 *
 * 09:00 on the 14th IST is 03:30 UTC. Anything that treats the instant as UTC and
 * subtracts a day files every morning scan under the previous day's heading, and
 * does so silently, for both days.
 */
export function calendarDay(
  start: string,
  totalDays: number,
  now: Date = new Date(),
): number {
  const todayInEventZone = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)

  const first = Date.parse(`${start}T00:00:00Z`)
  const thisDay = Date.parse(`${todayInEventZone}T00:00:00Z`)

  if (Number.isNaN(first) || Number.isNaN(thisDay)) return 1

  const elapsed = Math.round((thisDay - first) / 86_400_000) + 1
  return Math.min(Math.max(1, elapsed), totalDays)
}

/**
 * Reads the event row and resolves the active day.
 *
 * `today` is injectable so the calendar arithmetic can be asserted against fixed
 * dates instead of whatever day the suite happens to run on. Deriving "day 2" from
 * a real clock makes a test that passes today fail in three weeks.
 */
export async function resolveEventDay(now: Date = new Date()): Promise<EventDayState> {
  const { rows } = await db().query<{
    date: string
    end_date: string | null
    day_override: number | null
    locked_days: number[] | null
  }>(
    /*
      `to_char` on both dates, and this is load-bearing rather than a style choice.

      node-pg converts a Postgres DATE into a JS Date at local midnight. That Date
      stringifies as "Wed Oct 14 2026 00:00:00 GMT+0530 (...)", which is not ISO, so
      `Date.parse(`${date}T00:00:00Z`)` returns NaN — and `totalDaysFor` then
      silently floors to one day. The result is a portal that believes it is a
      one-day event and refuses a day-two override as out of range, with nothing
      anywhere reporting a problem.

      Formatting in Postgres keeps the calendar date exactly as it was entered,
      which is why `sendEvent` already does the same thing.
    */
    `select to_char(date, 'YYYY-MM-DD')     as date,
            to_char(end_date, 'YYYY-MM-DD') as end_date,
            day_override,
            locked_days
       from events order by date desc limit 1`,
  )

  const event = rows[0]
  if (!event) {
    // No event means no schedule, so there is nothing to be day two of. Scanning
    // still has to work — this is what a fresh database looks like mid-setup.
    return {
      activeDay: 1,
      calendarDay: 1,
      totalDays: 1,
      overridden: false,
      lockedDays: [],
    }
  }

  const totalDays = totalDaysFor(event.date, event.end_date)
  const fromCalendar = calendarDay(event.date, totalDays, now)

  /*
    An override that points outside the event is ignored rather than honoured.
    A stale or mistyped override that set the active day to 9 would silently split
    attendance into a day that does not exist, and the export would show a column
    nobody recognises.
  */
  const override =
    event.day_override !== null &&
    Number.isInteger(event.day_override) &&
    event.day_override >= 1 &&
    event.day_override <= totalDays
      ? event.day_override
      : null

  const activeDay = override ?? fromCalendar

  /*
    Locks are filtered to days that exist, and de-duplicated.

    A stale `locked_days` holding a day the event no longer has — from a schedule
    that was shortened, or a hand-edited row — must not make the set look larger
    than the event. It would render a lock badge against nothing and, worse, make
    "is the live day locked?" depend on values nobody can see in the UI.
  */
  const lockedDays = [
    ...new Set(
      (event.locked_days ?? []).filter(
        (day) => Number.isInteger(day) && day >= 1 && day <= totalDays,
      ),
    ),
  ].sort((a, b) => a - b)

  return {
    activeDay,
    calendarDay: fromCalendar,
    totalDays,
    overridden: override !== null,
    lockedDays,
  }
}

/**
 * Whether attendance may still be recorded against a day.
 *
 * Separate from the future-day rule on purpose. That one is structural — the server
 * picks the day, so a day that has not happened cannot be reached. This one is a
 * human decision about a day that HAS happened, and it has to be checked explicitly
 * because nothing about the calendar implies it.
 */
export function isDayLocked(state: EventDayState, day: number): boolean {
  return state.lockedDays.includes(day)
}