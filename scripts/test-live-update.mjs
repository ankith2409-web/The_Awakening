#!/usr/bin/env node
/**
 * The live-update wiring.
 *
 * These are source-level assertions rather than HTTP ones, and that is the point.
 *
 * Everything else in this suite set drives the API from outside and checks what comes
 * back. That cannot see the thing most likely to break here: somebody deleting a
 * `setInterval`, or a stop condition, or the change check that keeps a poll from
 * re-rendering the dashboard forever. All of those are one-line deletions that leave
 * every request passing and every test green, and the symptom is only visible on a
 * phone at a door — a volunteer's scanner offering a closed day, or an attendee's
 * dashboard frozen on "not marked yet" while the record is already written.
 *
 * So the assertions are about the mechanism, and each names the bug it prevents.
 * No database, no server.
 */

import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function report() {
  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}

const read = (path) => readFileSync(path, 'utf8')

/**
 * The source with its comments and doc-comments stripped.
 *
 * This matters more than it looks. Several assertions below are of the form "this code
 * must NOT do X" — and this codebase explains exactly why it does not, in a comment
 * sitting a few lines away. Reading the raw file meant a comment containing
 * `JSON.stringify(event)` satisfied a check for "does not call JSON.stringify", which
 * is the assertion passing for the wrong reason.
 *
 * A check about code has to read code. Comments are documentation, and documentation
 * legitimately names the thing it is describing.
 */
function code(path) {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const attendee = code('src/auth/AttendeeProvider.tsx')
const admin = code('src/auth/AdminProvider.tsx')
const liveEvent = code('src/auth/liveEvent.ts')
const probe = code('src/auth/probeSession.ts')
const panel = code('src/components/AttendancePanel.tsx')
const route = code('server/[...route].ts')
const auth = code('server/_lib/auth.ts')
const registerView = code('src/views/AuthViews.tsx')
const types = code('src/domain/types.ts')

/**
 * The text between two markers, exclusive.
 *
 * Needed because several assertions are about ONE function or ONE route case, and a
 * file-wide regex cannot tell them apart. Both of these read as passes on the wrong
 * evidence: `label="Password"` legitimately exists in LoginView, and the blanket
 * session delete legitimately exists in the admin reset — neither says anything about
 * registration or about the self-service change.
 */
function between(text, from, to) {
  const start = text.indexOf(from)
  if (start === -1) return ''
  const end = to === null ? text.length : text.indexOf(to, start + from.length)
  return text.slice(start, end === -1 ? text.length : end)
}

const registerOnly = between(
  read('src/views/AuthViews.tsx').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1'),
  'export function RegisterView',
  null,
)

console.log('\n  Live update wiring\n')

/* -- the attendee's event poll ------------------------------------------- */

check(
  'the attendee polls the event',
  /setInterval/.test(attendee) && /portalApi\.getEvent\(\)/.test(attendee),
  'no interval calling getEvent',
)

check(
  'and skips while the tab is hidden, so an idle phone is not polling a database',
  /visibilityState === 'visible'/.test(attendee),
  'no visibility gate',
)

check(
  'and re-reads immediately when the tab comes back, rather than waiting out the interval',
  /addEventListener\('visibilitychange'/.test(attendee) &&
    /addEventListener\('focus'/.test(attendee),
  'no visibilitychange/focus listener',
)

check(
  'a poll result is applied only when the event actually changed',
  /eventChanged\(current, next\)/.test(attendee),
  'the poll overwrites unconditionally, which re-renders the dashboard every tick',
)

check(
  'an event poll runs for ANONYMOUS visitors too, or the register form can never learn it closed',
  /GET \/event` is public|fetched for EVERYONE/.test(attendee) ||
    !/status === 'active'[^]*?\n\s*void loadDashboard\(\)\s*\n\s*\}\s*\n\s*\], \[\]\)/.test(attendee),
  'the event poll appears to be gated on a session',
)

/* -- the attendance poll, and what it must NOT carry --------------------- */

check(
  'the attendance record poll is still there, so a mark appears without a reload',
  /getMyAttendance/.test(attendee),
  'the attendance poll is gone',
)

check(
  'and stops once the attendee is marked, which is correct for an append-only log',
  /markedForToday/.test(attendee),
  'the stop condition was removed; it would poll for ever on a phone',
)

/*
  THE REGRESSION THIS EXISTED TO CATCH.

  `/attendee/attendance` used to carry the day state as well as its records. The poll
  above stops the moment the attendee is marked — correctly — and that silently froze
  the duplicated day state with it. Reopening a closed day then left every already
  marked attendee reading "Closed" until they reloaded by hand.
*/
check(
  'the attendance poll no longer carries the day state',
  /return json\(res, 200, \{ records: rows \}\)/.test(route),
  '/attendee/attendance is still returning the day state',
)

check(
  'MyAttendance is records only',
  /export interface MyAttendance \{\s*\n\s*readonly records: readonly CheckIn\[\]\s*\n\}/.test(types),
  'MyAttendance still carries day state',
)

check(
  'the panel reads locks and the active day from the event, not from attendance',
  /event\?\.lockedDays/.test(panel) && /event\?\.activeDay/.test(panel) &&
    !/attendance\?\.lockedDays/.test(panel) && !/attendance\?\.activeDay/.test(panel),
  'AttendancePanel is reading day state from the attendance payload again',
)

/* -- the admin poll ------------------------------------------------------- */

check(
  'the admin portal polls too, or a volunteer phone misses an owner closing a day',
  /ADMIN_POLL_MS/.test(admin) && /setInterval/.test(admin) &&
    /portalApi\.getEvent\(\)/.test(admin),
  'no admin interval',
)

check(
  'and it polls the attendance log, so marks made on another device appear',
  /listAttendance/.test(admin),
  'the admin poll does not read the log',
)

check(
  'an in-flight poll is discarded if a write landed while it was in the air',
  /seq !== writeSeq\.current/.test(admin),
  'a stale poll response can undo the write it raced with',
)

check(
  'every mutation bumps that counter',
  (admin.match(/writeSeq\.current \+= 1/g) ?? []).length >= 6,
  `only ${(admin.match(/writeSeq\.current \+= 1/g) ?? []).length} writes bump it`,
)

check(
  'the poll does not touch loadingData, which would strobe the skeletons every tick',
  !/setLoadingData\(true\)[\s\S]{0,400}listAttendance[\s\S]{0,400}setLoadingData/.test(admin),
  'the poll is toggling the loading state',
)

check(
  'the poll does not touch lastScan, which a volunteer is reading aloud',
  /lastScan/.test(admin) &&
    !/const poll = async[\s\S]{0,600}?setLastScan/.test(admin),
  'the poll is clearing the scan confirmation',
)

check(
  'the admin roster is NOT polled — it carries every attendee and changes only at registration',
  !/const poll = async[\s\S]{0,600}?listAttendees/.test(admin),
  'the roster is being refetched on every tick',
)

/* -- the change check ----------------------------------------------------- */

check(
  'events are compared field by field, not by JSON.stringify',
  /eventSignature/.test(liveEvent) && !/JSON\.stringify\(/.test(liveEvent),
  'comparison depends on key order, so an unchanged event would re-render forever',
)

check(
  'the signature covers everything the portal shows, agenda included',
  ['registrationMode', 'lockedDays', 'activeDay', 'phase', 'agenda', 'rosterCount'].every(
    (field) => liveEvent.includes(field),
  ),
  'a shown field is missing from the signature, so a change to it would not be seen',
)

/* -- not logging people out ---------------------------------------------- */

check(
  'a failed session probe does NOT declare the visitor anonymous',
  !/getAttendeeSession\(\)\s*\n\s*\.then[\s\S]{0,400}?\.catch\(\(\) => \{[^}]*setStatus\('anonymous'\)/.test(
    attendee,
  ),
  'the attendee probe still routes a failure straight to anonymous',
)

check(
  'nor does the admin probe',
  !/getAdminSession\(\)\s*\n\s*\.then[\s\S]{0,400}?\.catch\(\(\) => \{[^}]*setStatus\('anonymous'\)/.test(
    admin,
  ),
  'the admin probe still routes a failure straight to anonymous',
)

check(
  'both go through the retrying probe instead',
  /probeSession/.test(attendee) && /probeSession/.test(admin),
  'probeSession is not used by both providers',
)

check(
  'which retries exactly once — a third attempt would mean 24 seconds of boot screen',
  (probe.match(/await probe\(\)/g) ?? []).length === 2,
  `probeSession makes ${(probe.match(/await probe\(\)/g) ?? []).length} attempts`,
)

/* -- changing a password must not sign you out --------------------------- */

const selfServiceChange = between(
  route,
  "case 'POST /attendee/change-password'",
  "case 'POST /attendee/logout'",
)

check(
  'a self-service password change revokes only the OTHER sessions',
  /revokeOtherSessions/.test(selfServiceChange) &&
    !/delete from sessions/.test(selfServiceChange),
  'the self-service change deletes every session, including the one in use',
)

check(
  'and the helper explicitly keeps the caller\'s own token',
  /token_hash is distinct from/.test(auth),
  'revokeOtherSessions does not exclude the current session',
)

check(
  'the admin route still revokes all of them, which is right there',
  /case 'POST \/admin\/attendees\/password'[\s\S]*?delete from sessions where kind = 'attendee' and subject_id = \$1/.test(
    route,
  ),
  'the admin reset no longer revokes sessions, so a password change would not lock anybody out',
)

/* -- registration --------------------------------------------------------- */

check(
  'registration does not ask for a password — LoginView legitimately still has one',
  !/label="Password"/.test(registerOnly) && /Get my pass/.test(registerOnly),
  'the register form still collects a password',
)

check(
  'the issued password is shown full size and on its own',
  /text-4xl font-black/.test(registerOnly),
  'the password is not presented at a readable size',
)

check(
  'the read-back requires the two boxes to match',
  /typed\.first !== typed\.second/.test(registerOnly),
  'no client-side match check on the read-back',
)

check(
  'and is also checked against the server, which is the only thing that catches a password wrong in BOTH boxes',
  /verifyAttendeePassword/.test(registerOnly),
  'the read-back is only checked client-side',
)

check(
  'changing the password is offered, not imposed',
  /Would you like to change it to one of your own\?/.test(registerOnly),
  'there is no offer to change the password',
)

check(
  'and both answers are real buttons rather than a default',
  /Keep it/.test(registerOnly) && /Change it/.test(registerOnly),
  'the choice is not presented',
)

report()