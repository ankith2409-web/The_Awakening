/**
 * Event date formatting.
 *
 * The portal speaks to the database, which stores plain `YYYY-MM-DD` calendar
 * dates. Rendering those needs care in two places:
 *
 *   - `new Date('2026-10-14')` parses as UTC midnight, so formatting it in a
 *     timezone west of UTC yields the 13th. Every parse here is therefore
 *     pinned to UTC, and the parts are read back with `getUTC*`.
 *   - a two-day event must read as a range, not as two separate dates stacked
 *     on top of each other.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/** Parses `YYYY-MM-DD` without any timezone shifting. */
function parts(iso: string): { day: number; month: number; year: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  return { day, month, year }
}

/** e.g. `14 October 2026`. Falls back to the raw string if unparseable. */
export function formatEventDate(iso: string): string {
  const p = parts(iso)
  if (!p) return iso
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`
}

/**
 * e.g. `14–15 October 2026` for a two-day event, or `14 October 2026` when
 * there is no second day or it is the same day.
 */
export function formatEventDateRange(startIso: string, endIso?: string): string {
  const start = parts(startIso)
  if (!start) return startIso

  const end = endIso === undefined ? null : parts(endIso)
  if (!end || endIso === startIso) return formatEventDate(startIso)

  const startMonth = MONTHS[start.month - 1]
  const endMonth = MONTHS[end.month - 1]

  // Same month and year: "14–15 October 2026" reads better than repeating them.
  if (start.month === end.month && start.year === end.year) {
    return `${start.day}–${end.day} ${startMonth} ${start.year}`
  }

  // Same year, different month: "30 October – 2 November 2026".
  if (start.year === end.year) {
    return `${start.day} ${startMonth} – ${end.day} ${endMonth} ${start.year}`
  }

  // Different years: spell both out in full.
  return `${start.day} ${startMonth} ${start.year} – ${end.day} ${endMonth} ${end.year}`
}

/** e.g. `Wednesday 14 October 2026`, for agenda day headings. */
export function formatEventDayHeading(iso: string, dayNumber: number, totalDays?: number): string {
  const label = formatEventDate(iso)
  const weekday = weekdayOf(iso)
  const dayWord = totalDays !== undefined && totalDays > 1 ? `Day ${dayNumber} · ` : ''
  return weekday === null ? `${dayWord}${label}` : `${dayWord}${weekday} ${label}`
}

function weekdayOf(iso: string): string | null {
  const p = parts(iso)
  if (!p) return null
  // UTC, to match the parsing above.
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day))
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    date.getUTCDay()
  ] ?? null
}

/**
 * The calendar date of a given event day, so agenda items carrying only a
 * `day` number can be headed with the right date.
 */
export function dateForDay(startIso: string, dayNumber: number): string {
  const p = parts(startIso)
  if (!p) return startIso

  const date = new Date(Date.UTC(p.year, p.month - 1, p.day))
  date.setUTCDate(date.getUTCDate() + (dayNumber - 1))
  const iso = date.toISOString().slice(0, 10)
  return iso
}
