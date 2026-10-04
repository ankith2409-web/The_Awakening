import { normaliseSen } from './phone'
import type { Attendee } from './types'

/**
 * Roster search for the registration desk.
 *
 * Kept as a pure function rather than inline in the panel so it can be tested
 * directly — the interesting behaviour here is all in the normalising, and a
 * filter that only ever sees real keystrokes in a browser is not a filter anyone
 * has checked.
 *
 * Three fields, because staff arrive with different things in hand:
 *
 *   name  — someone who knows the attendee but not their number
 *   SEN   — the badge, which is the reliable one
 *   phone — a number read aloud, often with spaces or a country code
 *
 * All three are matched case-insensitively, and the SEN and phone are stripped
 * of punctuation first. A badge read aloud arrives as "A8661 75000012", and a
 * number dictated from a phone screen arrives as "+91 98765 43210"; without the
 * stripping, the person standing at the desk is told their own number is unknown,
 * which is the worst possible answer to give them.
 *
 * A number that arrives with a country code is also matched on its national tail.
 * Indian mobiles are stored as ten digits, so "+91 83103 29525" and "8310329525"
 * have to find the same person — staff copy numbers out of phones, and those
 * carry `+91`.
 *
 * An empty or whitespace-only query returns everything. That is deliberate: a
 * desk operator opening the panel wants the roster, not an empty state.
 */
export function matchesAttendeeQuery(
  attendees: readonly Attendee[],
  query: string,
): readonly Attendee[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return attendees

  const senNeedle = needle.replace(/[^a-z0-9]/g, '')
  const digitsNeedle = needle.replace(/\D/g, '')

  return attendees.filter((person) => {
    if (person.name.toLowerCase().includes(needle)) return true
    if (senNeedle !== '' && normaliseSen(person.sen).toLowerCase().includes(senNeedle)) {
      return true
    }

    const phone = person.phone ?? ''
    /*
      Both the empty guards and the order matter.

      A query with no digits cannot match a phone number, and checking anyway
      would let `includes('')` return true for everyone — a blank-looking search
      would silently return the whole roster.

      An empty stored phone cannot match either: `endsWith('')` is true, so a
      SEN-only record would appear in every phone search.
    */
    if (digitsNeedle === '' || phone === '') return false
    return phone.includes(digitsNeedle) || digitsNeedle.endsWith(phone)
  })
}