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

import { execFileSync } from 'node:child_process'
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

/* -- the UI must not state a fact it does not have ------------------------ */

/*
  `activeDay` and `totalDays` are both derived with a `?? 1` fallback, so before the
  event loads they render as "Day 1 of 1" — and the scan panel would assert, to the
  person at the door, that the event is a one-day event. That line exists so an
  operator can catch the portal disagreeing with the calendar, so a wrong number on it
  is worse than no number: an eye catches a figure and believes it.

  Found by opening the admin portal during a sweep and reading the line. It was brief,
  which is exactly why no test was looking for it.
*/
const adminView = code('src/views/admin/AdminPortalView.tsx')

check(
  'the scan panel knows whether the event has loaded',
  /dayKnown/.test(adminView) && /dayKnown=\{event !== null\}/.test(adminView),
  'the panel cannot tell a loaded event from an unloaded one',
)

check(
  'and does not print a day count before it knows one',
  /dayKnown \? \(/.test(adminView) && /Checking the day/.test(adminView),
  '"Day 1 of 1" is shown while the event is still loading',
)

check(
  'the closed-day advice points at the tab that actually has the control',
  !/Reopen it on the Programme tab/.test(adminView) && /Reopen it on the Event tab/.test(adminView),
  'the Programme tab was renamed to Event and the copy was not updated',
)

/* -- one number, from one place ------------------------------------------- */

/*
  The guest-list header went wrong twice, in opposite directions, which is the tell
  that there were two sources involved.

  First it read this panel's own fetch while the switch above it read the polled
  event, and the two disagreed on screen. Then it read the polled event, which is up
  to five seconds stale after an upload — so immediately after saving four students
  the header said "No guest list uploaded" directly under a notice saying four had
  landed.

  The panel now displays its own `getRoster()`, refreshed after every write it makes
  and whenever the polled count changes. `rosterCount` arrives purely as a re-read
  trigger and must not appear in any rendered count.
*/
const guestPanel = code('src/views/admin/GuestListPanel.tsx')
const displayed = guestPanel.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

check(
  'the guest-list count comes from the panel\'s own read, not the polled event',
  /\$\{current\.count\} student/.test(displayed) && !/\$\{rosterCount\}/.test(guestPanel),
  'a count is being rendered from the polled event, which lags an upload by up to five seconds',
)

check(
  'and the polled count is still wired in, as the re-read trigger',
  /rosterCount: number/.test(guestPanel) && /\}, \[rosterCount\]\)/.test(guestPanel),
  'the panel no longer refreshes when the list is replaced on another device',
)

/* -- display type must not push a page sideways --------------------------- */

/*
  The headings were a fixed `text-6xl`. At 60px, "REGISTER" is 237px of type, and a
  270px phone has 222px of content box after the padding — so the heading overflowed its
  own box and the whole page scrolled sideways.

  This was missed twice. The first overflow sweep checked `getBoundingClientRect().right`
  against the viewport, and the heading's BOX fitted — only its text did not. The
  detector was wrong, not the layout being subtle: anything that overflows inside a box
  that itself fits is invisible to a right-edge check. `scrollWidth > clientWidth` is
  what catches it.
*/
const headings = [
  ['AuthShell', 'src/components/AuthShell.tsx'],
  ['DashboardView', 'src/views/DashboardView.tsx'],
  ['AdminPortalView', 'src/views/admin/AdminPortalView.tsx'],
]

for (const [label, path] of headings) {
  const source = code(path)
  check(
    `${label} sizes its display heading fluidly rather than at a fixed size`,
    /text-\[clamp\(/.test(source) && !/text-6xl font-black uppercase/.test(source),
    `${label} can still push the page sideways on a narrow phone`,
  )
}

/* -- the slide link must survive being styled as a button ------------------ */

/*
  `SlideNavLink` renders the label twice — a resting copy and an accent-coloured copy
  that slides over it on hover — and the effect depends on the two sharing one box.

  The registration page styled that anchor as a full-width button with `inline-flex
  justify-center`, which overrides the anchor's display. `justify-center` then centred
  the in-flow copy at left:254 while the absolutely-positioned one stayed pinned to the
  left edge, so hovering showed the label twice at once: accent-coloured over on the
  left, paper-coloured in the middle. Both were real positions; neither was right.

  Fixed by putting the two copies inside an inner block the caller cannot restyle.
*/
const typography = code('src/components/Typography.tsx')

check(
  'SlideNavLink stacks its two label copies in an inner block',
  /<span className="relative block">[\s\S]*?group-hover:-translate-y-full[\s\S]*?absolute inset-0/.test(
    typography,
  ),
  'the copies are direct children of the anchor, so a display override pulls them apart',
)

check(
  'and the button that broke it no longer uses SlideNavLink',
  !/bg-swiss-ink[\s\S]{0,80}SlideNavLink/.test(registerOnly) &&
    /<Link[\s\S]{0,120}to="\/login"/.test(registerOnly),
  'the full-width Log in button is still a SlideNavLink',
)

/* -- one contact address, in one file -------------------------------------- */

/*
  The contact address had already drifted once. `src/domain/contact.ts` exists
  precisely to stop that, and its own comment says the value "lives here rather than
  being declared in either component" — naming two components, when by then three
  pieces of copy in `types.ts` and `AttendancePanel.tsx` each carried their own
  literal. Changing the address meant finding all four by hand.

  It is one literal in one file now, and this asserts exactly that: any email address
  anywhere in `src/` is a failure unless it is the declaration itself.

  Deliberately does not pin WHICH address. A test that hardcodes an inbox breaks when
  the inbox changes, and invites the wrong fix — pasting the new address into whatever
  failed. Which inbox is a decision, not a spec; that there is only one of them is the
  invariant worth keeping.
*/
const srcFiles = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const literals = []
for (const file of srcFiles) {
  const source = read(file)
  // Strip comments, so prose about an address is not mistaken for a copy of one.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  for (const match of codeOnly.matchAll(/['"`][^'"`\n]*@[a-z0-9.-]+\.[a-z]{2,}[^'"`\n]*['"`]/gi)) {
    literals.push(`${file}: ${match[0]}`)
  }
}

check(
  'the contact address is declared exactly once in src/',
  literals.length === 1 && literals[0].startsWith('src/domain/contact.ts'),
  literals.length === 0
    ? 'no address found at all — has CONTACT_EMAIL been removed?'
    : `${literals.length} literals: ${literals.join(' | ')}`,
)

check(
  'and every other place reads it rather than repeating it',
  code('src/domain/types.ts').includes('${CONTACT_EMAIL}') &&
    code('src/components/AttendancePanel.tsx').includes('${CONTACT_EMAIL}') &&
    code('src/components/SiteFooter.tsx').includes('CONTACT_EMAIL') &&
    code('src/components/PasswordHelp.tsx').includes('CONTACT_EMAIL'),
  'at least one component still carries its own copy of the address',
)

/* -- no mojibake: every character here is one we meant to type ------------- */

/*
  `src/views/AuthViews.tsx` shipped seven em dashes and one arrow as `GCo`, `GaAE` and
  the rest — UTF-8 bytes read through CP1257, the Windows Baltic codepage. On the login
  page that arrow is the "Register" link, so the portal rendered "REGISTER GaAE" to
  everybody, live, and every test passed: no suite looks at what a glyph actually is.

  The corruption is structural rather than accidental, which is what makes it worth a
  test. Decoding UTF-8 through any single-byte codepage always lands in U+0080..U+024F,
  because that band is what a byte-oriented codepage has for characters the source never
  contained. So the band is the tell. Anything in it that is not one we deliberately
  typed is a decoding accident, and it is found by asking what the character is rather
  than by searching for the specific mojibake it became — a search for `GaAE` would
  have missed `GCo` sitting three lines above it, and would miss the next codepage
  someone uses.

  Three characters in `src/` and `server/` are genuinely in that band, and each is
  listed with why. Everything else fails.

  The confusable-name corpus in `server/_lib/identifiers.ts` is outside this check by
  construction: its Greek, Cyrillic, Arabic, Indic and Han characters are all above
  U+024F, because they are real test data for the no-emoji rule, not corruption.
*/
const LATIN_BAND_ALLOWED = new Map([
  ['©', 'copyright, in the site footer'],
  ['·', 'the middot separator in "FETCH AI · GDG"'],
  ['é', 'an accented example name in the identifiers comment'],
])

const bandOffenders = []

for (const file of execFileSync('git', ['ls-files', 'src', 'server'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)) {
  const seen = new Set()
  for (const ch of readFileSync(file, 'utf8')) {
    const cp = ch.codePointAt(0)
    if (cp < 0x80 || cp > 0x24f) continue
    if (LATIN_BAND_ALLOWED.has(ch)) continue
    const key = `${file}: ${ch} U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
    if (!seen.has(key)) {
      seen.add(key)
      bandOffenders.push(key)
    }
  }
}

check(
  'no character in src/ or server/ is the residue of a decoding accident',
  bandOffenders.length === 0,
  bandOffenders.length === 0
    ? 'none found'
    : `${bandOffenders.length} suspect character(s): ${bandOffenders.slice(0, 6).join(', ')}${bandOffenders.length > 6 ? ', ...' : ''}`,
)

check(
  'and the allowlist has not grown to hide one',
  LATIN_BAND_ALLOWED.size === 3,
  `the allowlist holds ${LATIN_BAND_ALLOWED.size} entries; every addition needs a reason and a review`,
)

check(
  'the link the corruption landed on is a real arrow again',
  /to="\/register"[\s\S]{0,200}>/.test(code('src/views/AuthViews.tsx')) &&
    code('src/views/AuthViews.tsx').includes('Register →'),
  'the Register link on the login page is not showing a real arrow',
)

/* -- the site footer reaches every attendee page -------------------------- */

/*
  THIS ONE EXISTS BECAUSE IT ALREADY FAILED ONCE.

  `LoginView` lost its `showSiteFooter` when a bad file splice was reverted, and it
  shipped. Nothing caught it: the automated suites check copy, links and layout, and a
  missing footer breaks none of them. It was found by opening every page at three phone
  widths and asking "is the footer there", which is not a thing any test was doing.

  So it is a test now. One prop, on the wrong view, is exactly the kind of regression
  that only shows up if somebody looks at the page.
*/
const footerViews = [
  ['LoginView', 'src/views/AuthViews.tsx', 'export function LoginView'],
  ['RegisterView', 'src/views/AuthViews.tsx', 'export function RegisterView'],
]

for (const [label, path, from] of footerViews) {
  const body = between(code(path), from, null)
  check(
    `${label} renders the site footer`,
    /<AuthShell[\s\S]*?showSiteFooter[\s\S]*?>/.test(body),
    `${label} does not pass showSiteFooter, so its page has no Hosted by / Connect block`,
  )
}

check(
  'the attendee dashboard renders the site footer',
  /<SiteFooter\s*\/>/.test(code('src/views/DashboardView.tsx')),
  'DashboardView has no footer',
)

check(
  'the landing page renders the site footer',
  /<SiteFooter\s*\/>/.test(code('src/views/LandingView.tsx')),
  'LandingView has no footer',
)

check(
  'the auth shell renders it only when asked',
  /\{showSiteFooter \? <SiteFooter \/> : null\}/.test(code('src/components/AuthShell.tsx')) &&
    /showSiteFooter = false/.test(code('src/components/AuthShell.tsx')),
  'the footer is unconditional, which would put it on the shared admin sign-in too',
)

check(
  'the admin sign-in does NOT ask for it',
  !between(code('src/views/admin/AdminLoginView.tsx'), '<AuthShell', null).includes(
    'showSiteFooter',
  ),
  'the public Hosted by / Connect block is on the staff door',
)

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
  'the issued password is shown large, monospaced and on its own line',
  /select-all break-all font-mono text-\[clamp/.test(registerOnly),
  'the password is not presented at a readable size',
)

check(
  'the choice is ON THE SAME SCREEN as the password, not behind another step',
  /!useOwn \? \(/.test(registerOnly) &&
    /Use this password/.test(registerOnly) &&
    /Type my own instead/.test(registerOnly),
  'the generated password and the choice to keep or replace it are on separate screens',
)

check(
  'there is no read-back step — nobody retypes the password they were just given',
  !/verifyAttendeePassword/.test(registerOnly) &&
    !/Type your password/.test(registerOnly),
  'the generated password is still being asked for twice',
)

check(
  'the flow is three steps, not five',
  /type RegisterStep = 'details' \| 'password' \| 'done'/.test(code('src/views/AuthViews.tsx')),
  'the registration flow still has separate reveal, read-back and change screens',
)

check(
  'the guest list is NOT announced on the attendee form',
  !/Guest list only/.test(registerOnly),
  'the register page still tells the visitor their SEN is being checked against a list',
)

report()