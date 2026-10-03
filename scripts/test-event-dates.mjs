/**
 * Checks the event date formatting.
 *
 * These are pure functions with a timezone trap in them — `new Date('2026-10-14')`
 * is UTC midnight, so any local-time formatting can report the day before. That
 * is exactly the class of bug that only shows up on a machine in a negative
 * UTC offset, i.e. never on the developer's laptop.
 *
 *   node --experimental-strip-types scripts/test-event-dates.mjs
 */

import {
  dateForDay,
  formatEventDate,
  formatEventDateRange,
  formatEventDayHeading,
} from '../src/lib/eventDate.ts'

let passed = 0
let failed = 0

function check(label, actual, expected) {
  if (actual === expected) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}\n          got:  ${actual}\n          want: ${expected}`)
  }
}

console.log('\n  Event dates\n')

// The real event.
check('single day', formatEventDate('2026-10-14'), '14 October 2026')
check('two-day range, same month', formatEventDateRange('2026-10-14', '2026-10-15'), '14–15 October 2026')
check('no end date', formatEventDateRange('2026-10-14'), '14 October 2026')
check('end date equal to start', formatEventDateRange('2026-10-14', '2026-10-14'), '14 October 2026')
check('cross-month range', formatEventDateRange('2026-10-30', '2026-11-02'), '30 October – 2 November 2026')
check('cross-year range', formatEventDateRange('2026-12-30', '2027-01-02'), '30 December 2026 – 2 January 2027')

// 14 Oct 2026 is a Wednesday; 15 Oct a Thursday.
check('day heading with weekday', formatEventDayHeading('2026-10-14', 1, 2), 'Day 1 · Wednesday 14 October 2026')
check('day 2 heading', formatEventDayHeading('2026-10-15', 2, 2), 'Day 2 · Thursday 15 October 2026')
check('single-day event omits the day word', formatEventDayHeading('2026-10-14', 1, 1), 'Wednesday 14 October 2026')

check('date for day 1', dateForDay('2026-10-14', 1), '2026-10-14')
check('date for day 2', dateForDay('2026-10-14', 2), '2026-10-15')
check('date for day 3 rolls the month', dateForDay('2026-10-30', 3), '2026-11-01')

// The trap: a naive local-time parse would return the 13th west of UTC.
check('month boundary survives UTC parsing', formatEventDate('2026-01-01'), '1 January 2026')
check('year boundary survives UTC parsing', formatEventDate('2027-01-01'), '1 January 2027')
check('leap day', formatEventDate('2028-02-29'), '29 February 2028')

// Garbage in must not throw — the dashboard degrades rather than crashing.
check('malformed input passes through', formatEventDate('not-a-date'), 'not-a-date')
check('out-of-range month passes through', formatEventDate('2026-13-45'), '2026-13-45')
check('malformed range falls back to start', formatEventDateRange('bad', '2026-10-15'), 'bad')

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
