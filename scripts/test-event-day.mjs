#!/usr/bin/env node
/**
 * Which day of the event a scan belongs to.
 *
 * `calendarDay` is the piece of this feature that can fail silently, so it gets
 * its own suite rather than riding along with the HTTP tests.
 *
 * The failure mode it guards is specific and quiet: computing "what day is it in
 * Bengaluru" by subtracting 86,400,000 ms from a UTC instant. That works right up
 * until it does not, and when it does not every morning scan is filed under the
 * previous day — for both days, with no error anywhere. A test that only ran "today"
 * would pass for months and then be wrong on the morning of the event.
 *
 * So every case here is a FIXED date, asserted against a fixed expectation.
 *
 *   node --experimental-strip-types --no-warnings scripts/test-event-day.mjs
 */

import { calendarDay, totalDaysFor } from '../server/_lib/eventDay.ts'

let passed = 0
let failed = 0

function check(label, actual, expected) {
  if (actual === expected) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}  got ${actual}, want ${expected}`)
  }
}

const START = '2026-10-14'
const END = '2026-10-15'

/* -- how long the event runs ------------------------------------------------ */

check('a two-day span is two days', totalDaysFor(START, END), 2)
check('a one-day span is one day', totalDaysFor(START, START), 1)
check('a missing end date means one day', totalDaysFor(START, null), 1)
check('a null end date means one day', totalDaysFor(START, undefined), 1)

/*
  A reversed span is nonsense data, and it must not produce a negative day count
  that then propagates into a `day` column and fails a CHECK constraint at the
  gate. One day is the only safe floor.
*/
check('a reversed span floors at one day', totalDaysFor(END, START), 1)
check('garbage dates floor at one day', totalDaysFor('not-a-date', 'also-not'), 1)

/*
  The regression that actually happened.
  `resolveEventDay` selected `end_date` raw, node-pg turned it into a JS Date, and
  that Date stringifies as "Wed Oct 14 2026 00:00:00 GMT+0530 (...)" — not ISO, so
  `Date.parse` returned NaN and a two-day event reported itself as one day. Every
  downstream number was then wrong and nothing reported it.

  So a Date object must NOT be silently accommodated here. Coercing it would hide
  the next mistake of the same shape; rejecting it makes the caller cast.
*/
check(
  'a JS Date is rejected rather than coerced — casting hides the real mistake',
  totalDaysFor(new Date('2026-10-14T00:00:00Z'), new Date('2026-10-15T00:00:00Z')),
  1,
)

check(
  'a locale-formatted date string is rejected too',
  totalDaysFor('Wed Oct 14 2026 00:00:00 GMT+0530 (India Standard Time)', null),
  1,
)

check(
  'an ISO timestamp with a time is rejected — only the date is a calendar date',
  totalDaysFor('2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z'),
  1,
)

/* -- before, on, and after the window --------------------------------------- */

/*
  All the "now" values are UTC instants chosen so that the Bengaluru local date is
  unambiguous. Bengaluru is UTC+05:30 with no daylight saving, so 18:30 UTC on the
  13th is already 00:00 on the 14th there — the first moment of day one.
*/
const utc = (iso) => new Date(iso)

check(
  'the first minute of day one in Bengaluru is day one',
  calendarDay(START, 2, utc('2026-10-13T18:30:00Z')),
  1,
)

/*
  The two cases a naive UTC implementation gets wrong, stated as pairs so the
  failure is visible as a wrong ANSWER rather than a diff:

    03:30 UTC on the 14th is 09:00 IST on the 14th. Treating the instant as UTC
    makes "today" the 14th and the day 1 — right by luck.

    18:30 UTC on the 14th is 00:00 IST on the 15th. Treating the instant as UTC
    makes "today" the 14th, so the portal says day one while the organisers are
    opening day two. This is the one that would have bitten.
*/
check(
  '09:00 in Bengaluru on day one resolves to day one',
  calendarDay(START, 2, utc('2026-10-14T03:30:00Z')),
  1,
)

check(
  'midnight in Bengaluru starting day two resolves to day two',
  calendarDay(START, 2, utc('2026-10-14T18:30:00Z')),
  2,
)

check(
  '09:00 in Bengaluru on day two resolves to day two',
  calendarDay(START, 2, utc('2026-10-15T03:30:00Z')),
  2,
)

/* -- clamping --------------------------------------------------------------- */

/*
  Before the event it is day one, and after it the last day.

  Not "no day". Every test scan anyone has ever run against this portal happened
  outside the window, so refusing to resolve one would mean the gate is unusable
  for testing — and clamping is also what an organiser means by "we are not live
  yet, just leave it somewhere sensible".
*/
check(
  'a month before the event is day one',
  calendarDay(START, 2, utc('2026-09-14T03:30:00Z')),
  1,
)

check(
  'a month after the event is the last day',
  calendarDay(START, 2, utc('2026-11-15T03:30:00Z')),
  2,
)

check(
  'the day before the event is still day one',
  calendarDay(START, 2, utc('2026-10-13T03:30:00Z')),
  1,
)

check(
  'the day after the event is still the last day',
  calendarDay(START, 2, utc('2026-10-16T03:30:00Z')),
  2,
)

/*
  A three-day event on the middle day must be day two, not day one. Guards the
  clamp arithmetic itself rather than the two-day case it was written for.
*/
check(
  'the middle day of a three-day event is day two',
  calendarDay('2026-10-14', 3, utc('2026-10-15T03:30:00Z')),
  2,
)

check(
  'the last day of a three-day event is day three',
  calendarDay('2026-10-14', 3, utc('2026-10-16T03:30:00Z')),
  3,
)

/* -- the boundary hour, stated both ways ------------------------------------ */

/*
  The exact hour the day rolls over, in both directions.

  18:29:59 UTC on the 14th is 23:59:59 in Bengaluru — the last second of day one.
  One second later it is day two. If either of these is wrong, half the scans at
  the handover are filed under the wrong day.
*/
check(
  'the final minute before midnight in Bengaluru is still day one',
  calendarDay(START, 2, utc('2026-10-14T18:29:00Z')),
  1,
)

check(
  'the first minute after midnight in Bengaluru is day two',
  calendarDay(START, 2, utc('2026-10-14T18:30:00Z')),
  2,
)

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1