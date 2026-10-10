/**
 * The registration desk: roster search, and the absence of self-service recovery.
 *
 * Two halves that belong together. `matchesAttendeeQuery` is the only real logic
 * in the panel and is tested as a function, because a filter that has only ever
 * been exercised by clicking is a filter nobody has checked. The second half
 * asserts things about the source that are easy to undo by accident: a
 * reintroduced "Forgot password?" link, a route for it, or a component that
 * offers self-service recovery again.
 *
 * Bundled with esbuild before running, like `test:copy` and `test:errors` —
 * `attendeeSearch` imports the real `phone` module, and importing the shipped
 * code is the point.
 *
 *   npm run test:desk
 */

import { matchesAttendeeQuery } from '@/domain/attendeeSearch'
import { count, readCode, tally } from './_source.mjs'

const { check, report } = tally()

/**
 * Fixtures shaped like real roster rows.
 *
 * Deliberately not the mock's demo attendee: a suite that reuses the demo data
 * cannot catch a filter that accidentally only works for one record. The third
 * row has no phone at all, because the admin projection makes it optional and a
 * filter that assumed otherwise would throw on a real roster.
 */
const ROSTER = [
  { id: 'a1', name: 'Ankith Kumar', phone: '8310329525', sen: 'A866175000012', createdAt: '' },
  { id: 'a2', name: 'amulya patil', phone: '6362790849', sen: 'A866175000013', createdAt: '' },
  { id: 'a3', name: 'Maryum', phone: null, sen: 'A866175000014', createdAt: '' },
]

const names = (rows) => rows.map((row) => row.name).join(', ')

/* -- the search ------------------------------------------------------------- */

check('an empty query returns the whole roster', matchesAttendeeQuery(ROSTER, '').length === 3)
check(
  'a whitespace-only query returns the whole roster',
  matchesAttendeeQuery(ROSTER, '   ').length === 3,
  names(matchesAttendeeQuery(ROSTER, '   ')),
)

check(
  'matches on a full name',
  names(matchesAttendeeQuery(ROSTER, 'Ankith Kumar')) === 'Ankith Kumar',
  names(matchesAttendeeQuery(ROSTER, 'Ankith Kumar')),
)

check(
  'matches a partial name',
  names(matchesAttendeeQuery(ROSTER, 'patil')) === 'amulya patil',
  names(matchesAttendeeQuery(ROSTER, 'patil')),
)

check(
  'name matching is case-insensitive',
  names(matchesAttendeeQuery(ROSTER, 'PATIL')) === 'amulya patil',
  names(matchesAttendeeQuery(ROSTER, 'PATIL')),
)

check(
  'a lowercase name matches however it is stored',
  names(matchesAttendeeQuery(ROSTER, 'AMULYA')) === 'amulya patil',
  names(matchesAttendeeQuery(ROSTER, 'AMULYA')),
)

/*
  The case that motivated the normalisation: a badge read aloud. An organiser
  saying "A8661 75000012" and typing it with a space in the middle must land on
  the same person as the clean string, or the desk tells them their own badge
  number is unknown.
*/
check(
  'a SEN read aloud with a space in it still finds its owner',
  names(matchesAttendeeQuery(ROSTER, 'A8661 75000012')) === 'Ankith Kumar',
  names(matchesAttendeeQuery(ROSTER, 'A8661 75000012')),
)

check(
  'a lowercase SEN matches the stored uppercase form',
  names(matchesAttendeeQuery(ROSTER, 'a866175000013')) === 'amulya patil',
  names(matchesAttendeeQuery(ROSTER, 'a866175000013')),
)

check(
  'a SEN typed with surrounding whitespace matches',
  matchesAttendeeQuery(ROSTER, '   A866175000014   ').length === 1,
  names(matchesAttendeeQuery(ROSTER, '   A866175000014   ')),
)

check(
  'a phone number matches',
  names(matchesAttendeeQuery(ROSTER, '8310329525')) === 'Ankith Kumar',
  names(matchesAttendeeQuery(ROSTER, '8310329525')),
)

check(
  'a phone number with spaces and a country code still matches',
  names(matchesAttendeeQuery(ROSTER, '+91 83103 29525')) === 'Ankith Kumar',
  names(matchesAttendeeQuery(ROSTER, '+91 83103 29525')),
)

check(
  'a phone number copied from a contacts card matches',
  names(matchesAttendeeQuery(ROSTER, '918310329525')) === 'Ankith Kumar',
  names(matchesAttendeeQuery(ROSTER, '918310329525')),
)

check(
  'an attendee with no phone does not appear in a phone search',
  matchesAttendeeQuery(ROSTER, '83103').every((row) => row.phone !== null),
  names(matchesAttendeeQuery(ROSTER, '83103')),
)

check(
  'an attendee with no phone is still findable by SEN',
  names(matchesAttendeeQuery(ROSTER, 'A866175000014')) === 'Maryum',
  names(matchesAttendeeQuery(ROSTER, 'A866175000014')),
)

check(
  'an attendee with no phone does not break a name search',
  names(matchesAttendeeQuery(ROSTER, 'Maryum')) === 'Maryum',
  names(matchesAttendeeQuery(ROSTER, 'Maryum')),
)

check(
  'an unknown query returns nothing',
  matchesAttendeeQuery(ROSTER, 'zzzznobody').length === 0,
  names(matchesAttendeeQuery(ROSTER, 'zzzznobody')),
)

/*
  The subtle one. A query of only letters leaves `digitsNeedle` empty, and
  `includes('')` is true for every string — so without the guard a
  letters-only search would quietly return the entire roster while looking like
  a successful filter.
*/
check(
  'a letters-only query does not match everyone through an empty phone needle',
  matchesAttendeeQuery(ROSTER, 'qqqq').length === 0,
  names(matchesAttendeeQuery(ROSTER, 'qqqq')),
)

check(
  'a digits-only query does not match on the name',
  matchesAttendeeQuery(ROSTER, '8310329525').every((row) => row.name !== 'Maryum'),
  names(matchesAttendeeQuery(ROSTER, '8310329525')),
)

check(
  'a SEN prefix matches several people',
  matchesAttendeeQuery(ROSTER, 'a8661750000').length === 3,
  names(matchesAttendeeQuery(ROSTER, 'a8661750000')),
)

check('an empty roster does not throw', matchesAttendeeQuery([], 'anything').length === 0)

/* -- the panel -------------------------------------------------------------- */

const panel = readCode('src/views/admin/AttendeeDirectory.tsx')
const portalView = readCode('src/views/admin/AdminPortalView.tsx')
const app = readCode('src/App.tsx')
const auth = readCode('src/views/AuthViews.tsx')
const portalApi = readCode('src/domain/portal-api.ts')
const server = readCode('server/[...route].ts')

check('the panel is rendered by the admin portal', portalView.includes('<AttendeeDirectory />'))
/*
  The tab was renamed from "Desk" to "People" when the registration switch, the
  guest list and manual add were gathered into it. The assertion is that the roster
  of people who HAVE registered lives on a tab about people, not that it lives on
  one particular tab — so it follows the panel, not the label.
*/
check('the roster lives on a tab about people', /id: 'people'/.test(portalView))
/*
  Matched on `=== 'people'` rather than on a particular variable name: this
  assertion is about the tab actually rendering the panel, and it should not care
  what the state holding the current tab is called.
*/
check(
  'the People tab renders the panel, not just a label',
  /=== 'people'[\s\S]{0,1200}<AttendeeDirectory/.test(portalView),
)

check(
  'the panel names the flow staff are looking for',
  panel.includes('Password recovery'),
)

check(
  'the panel says the attendee is logged out by the change',
  panel.includes('ended by this'),
)

check(
  'the panel promises nothing about email',
  !/\bemail\b/i.test(panel),
  'a promise the portal does not keep sends staff looking for a mail client',
)

/*
  Focus on open, and where it is done from.

  The first version used `requestAnimationFrame`, which passed every manual
  check and then failed on the deployed site: rAF is tied to paint, and a
  backgrounded tab does not paint, so an organiser who opened a row and switched
  away came back with focus still on the body and their first keystrokes went
  nowhere. Effects run after commit whether or not anything is on screen.
*/
check(
  'the password box takes focus as the row opens',
  panel.includes('passwordRef.current?.focus()'),
)

check(
  'focus is not deferred to requestAnimationFrame',
  !/requestAnimationFrame/.test(panel),
  'rAF does not run in a backgrounded tab, so focus would never land',
)

check(
  'focus is driven by the open row rather than by a click handler',
  /useEffect\(\(\) => \{[\s\S]{0,120}passwordRef\.current\?\.focus\(\)/.test(panel),
)

check(
  'exactly one row can be open',
  panel.includes('setOpenSen(null)') && count(panel, /setOpenSen\(sen\)/g) === 1,
)

check(
  'a refused change leaves the form open so staff can correct the SEN',
  panel.includes('result === null') && /return\s*\n?\s*\}/.test(panel),
)

check(
  'the roster is capped so 500 people stays scrollable',
  /const PAGE = \d+/.test(panel) && panel.includes('matches.slice(0, PAGE)'),
)

/*
  The regression this whole change exists to prevent. Each of these can come back
  without failing any other test, which is why they are asserted on the source.
*/
check(
  'no view links to a forgot-password route',
  !/to="\/forgot-password"/.test(auth) && !/href="\/forgot-password"/.test(app),
)

check(
  'the client API exposes no self-service password reset',
  !/resetAttendeePassword\(input:/.test(portalApi),
)

check(
  'the client API does expose the admin-mediated change',
  portalApi.includes('adminSetAttendeePassword(input:'),
)

check(
  'the server no longer routes a public reset',
  !/case 'POST \/attendee\/password\/reset'/.test(server),
)

check(
  'the server routes an admin-mediated change',
  server.includes("case 'POST /admin/attendees/password'"),
)

check(
  'the admin change is identified by SEN',
  server.includes("normaliseSen(requireString(body, 'sen'))"),
)

check(
  'the admin change revokes that attendee\u2019s sessions',
  server.includes("delete from sessions where kind = 'attendee'"),
)

check(
  'the attendee is told to email the organiser rather than use a dead link',
  auth.includes('<PasswordHelp />') && !auth.includes('Ask any organiser'),
  'the login form must not carry its own copy of the password-help text',
)

const passwordHelp = readCode('src/components/PasswordHelp.tsx')
const contact = readCode('src/domain/contact.ts')

check(
  /*
    Deliberately asserts the SHAPE, not a particular address.

    This used to pin the literal, which meant changing the contact address broke a
    test that was never about the address at all — and, worse, invited the fix of
    hardcoding the new one in whatever failed. It only needs to know that the value
    lives in one place and is a real mailto target; which inbox is a decision, not a
    spec.
  */
  'the password help names the organiser address, from the one place it is declared',
  passwordHelp.includes('CONTACT_EMAIL') && /CONTACT_EMAIL = '[^']+@[^']+'/.test(contact),
)

check(
  'the address is a real mailto, not text to retype',
  /href=\{`mailto:\$\{CONTACT_EMAIL\}/.test(passwordHelp),
)

check(
  'the subject line is pre-filled so a request arrives identifiable',
  passwordHelp.includes('PASSWORD_RESET_SUBJECT') &&
    contact.includes('PASSWORD_RESET_SUBJECT'),
)

check(
  'the address wraps on a narrow phone instead of overflowing',
  passwordHelp.includes('wrap-anywhere'),
)

check(
  'the help is labelled for assistive technology, not just styled',
  passwordHelp.includes('aria-labelledby="password-help-heading"') &&
    passwordHelp.includes('id="password-help-heading"'),
)

/*
  One address, one home.

  It is now used in five places — the footer contact link, this help, the guest-list
  refusal, the registration-closed refusal, and the note on a closed attendance day —
  so a second literal would be how one of them ends up pointing at an inbox nobody
  reads. On the password help that failure is invisible until somebody is locked
  out of their own event pass.

  It HAD drifted: the footer and this help used the constant while three pieces of
  copy each carried their own literal, so changing the address meant finding all four
  by hand. `test:live` now asserts there is exactly one address in `src/`.
*/
check(
  'the footer reads the same address from the same place',
  readCode('src/components/SiteFooter.tsx').includes(
    "import { CONTACT_EMAIL } from '@/domain/contact'",
  ) &&
    // No literal email of any kind, rather than "not the old one".
    !/@[a-z0-9.-]+\.[a-z]{2,}/i.test(readCode('src/components/SiteFooter.tsx')),
)

/* -- the People panel is owner-only ------------------------------------------ */

/*
  The People tab changes somebody's credential, uploads the guest list and moves
  the registration switch. None of that is a door-side job, so it must be marked
  owner-only in the tab table — which is a one-word change that nothing else in the
  suite would notice.

  The route checks are the real control and live in `test:roles` and
  `test:guestlist`; this guards the half that is presentation, because a volunteer
  being shown a tab that 403s on every action is worse than one that is never shown.
*/
check(
  'the People tab is marked owner-only',
  /id: 'people',[^}]*ownerOnly: true/.test(portalView),
)

check(
  'an unrecognised role is treated as the narrower one',
  /const isOwner = admin\?\.role === 'owner'/.test(portalView),
  'anything but a literal owner comparison widens by accident',
)

check(
  'the roster is never requested for a non-owner',
  /isOwner \? portalApi\.listAttendees\(\) : Promise\.resolve/.test(
    readCode('src/auth/AdminProvider.tsx'),
  ),
)

/* -- per-day attendance ----------------------------------------------------- */

/*
  The day comes from the server and the client never sends one.

  A `day` in the request body would mean a stale control in a stale tab could file
  a morning's scans under the wrong heading — and nobody would find out until the
  export. So the assertion is about ABSENCE, which is easy to reintroduce by
  accident and impossible to notice.
*/
check(
  'the scan request sends no day',
  /recordAttendanceBySen[\s\S]{0,200}\{ sen \}/.test(
    readCode('src/api/http-portal.ts'),
  ) &&
    !/recordAttendanceBySen\([\s\S]{0,160}day:/.test(readCode('src/api/http-portal.ts')),
)

check(
  'the server resolves the day itself',
  server.includes('const dayState = await resolveEventDay()') &&
    server.includes('const day = dayState.activeDay'),
)

check(
  'and never reads a day from the request body',
  // Narrowed on purpose: `body.dayOverride` is the owner's pin, which IS meant to
  // come from the body. A bare `body.day` is what must never exist.
  !/body\.day(?!Override)/.test(server),
  'a client-supplied day could misattribute a whole queue of scans',
)

check(
  'the conflict is per day, so the same badge is admitted on the next day',
  server.includes('on conflict (attendee_id, day) do nothing'),
)

check(
  'the attendee is shown one row per day, including days with no record',
  readCode('src/components/AttendancePanel.tsx').includes(
    'Array.from({ length: totalDays }',
  ),
)

check(
  'the attendee polling waits for TODAY, not for any record',
  /record\.day === today/.test(readCode('src/auth/AttendeeProvider.tsx')),
  'otherwise an attendee marked on day one stops polling and day two never appears',
)

check(
  'the export names its day in the filename',
  readCode('src/lib/exportAttendance.ts').includes('day-${day}'),
)

check(
  'the export takes a required day rather than defaulting',
  /function downloadAttendanceCsv\([\s\S]*day: number,/.test(
    readCode('src/lib/exportAttendance.ts'),
  ),
)

report()