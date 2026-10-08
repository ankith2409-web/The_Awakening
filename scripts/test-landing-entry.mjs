#!/usr/bin/env node
/**
 * Landing page: both entry points stay visible on a phone.
 *
 * Guards a measured regression. At a 390px viewport the hero's two stacked 64px
 * buttons put "Register" at 581–645px and "Log in" at 646–710px — so on a
 * 667px-tall phone (iPhone SE) Log in fell *entirely* below the fold while the
 * red Register button sat above it. Someone who had already registered saw only
 * the call they did not need, and could not get back to their pass.
 *
 * Side-by-side puts both at 581–645px, above the fold with room to spare.
 *
 * These are static assertions because the defect is structural: an API-level
 * test cannot see a button's position. Layout is verified by measuring the
 * deployed page at a simulated phone viewport, not by these checks — they exist
 * so a future edit does not silently re-stack the row.
 *
 *   node --experimental-strip-types scripts/test-landing-entry.mjs
 */

import { count, declaration, readCode, tally, walk } from './_source.mjs'

const VIEW = 'src/views/LandingView.tsx'
const BUTTON = 'src/components/Button.tsx'
const APP = 'src/App.tsx'
const FOOTER = 'src/components/SiteFooter.tsx'

const view = readCode(VIEW)
const button = readCode(BUTTON)
const app = readCode(APP)

const { check, report } = tally()

console.log('\n  Landing page entry points\n')

/* -- 0. the hero renders for signed-in visitors too ------------------------- */

/*
  The reason this suite exists at all. `/` used to be
  `when="anonymous" redirect="/dashboard"`, so anyone holding a session cookie
  was bounced to their pass and the hero never rendered — reproduced on the live
  site. The shared link is the thing pasted into a group chat, and it has to show
  what it promises.
*/
check(
  'the landing route no longer bounces signed-in visitors',
  /path="\/"[\s\S]{0,220}when="any"/.test(app),
  '`/` is guarded by session status again, so the hero is unreachable when signed in',
)
check(
  'the guard can admit every state',
  /when !== 'any'/.test(app) || /when: SessionStatus \| 'any'/.test(app),
  "Guard has no way to allow both statuses, so `when=\"any\"` cannot work",
)
check(
  'the guard still waits out the session probe',
  /status === 'initialising'\) return <BootScreen \/>/.test(app),
  'removing the redirect must not make the hero flash Register then swap to Your pass',
)
check(
  'the hero reacts to the session',
  /signedIn/.test(view) && /useAttendee\(\)/.test(view),
  'the hero cannot tell a signed-in visitor from an anonymous one',
)
check(
  'a signed-in visitor is offered their pass, not a dead end',
  /to="\/dashboard"[\s\S]{0,80}Your pass/i.test(view),
  'no direct route to the pass for someone already signed in',
)
check(
  'Register and Log in are not offered to a signed-in visitor',
  /\{signedIn \?/.test(view) && /Register/.test(view) && /Log in/.test(view),
  'the signed-in branch does not replace the anonymous pair',
)

/* -- 1. both calls to action sit in one row --------------------------------- */

const actions = declaration(view, 'function Hero')

check(
  'the hero has an actions container',
  /id="hero-actions"/.test(actions),
  'the skip link target is gone, so keyboard users lose a shortcut too',
)
check(
  'the actions row is a row, not a column',
  /id="hero-actions"[\s\S]{0,200}flex-row/.test(actions),
  'the row was re-stacked, which puts Log in back below a 667px fold',
)
check(
  'the stacking is not undone at sm',
  !/flex-col[\s\S]{0,80}id="hero-actions"/.test(actions) &&
    !/id="hero-actions"[\s\S]{0,200}sm:flex-row/.test(actions),
  'a breakpoint override would re-stack it on exactly the short screens that matter',
)

/* -- 2. both destinations are present --------------------------------------- */

const links = [...actions.matchAll(/ButtonLink to="([^"]+)"/g)].map((m) => m[1])
check(
  'Register is offered', links.includes('/register'), `found ${links.join(', ')}`)
check(
  'Log in is offered', links.includes('/login'), `found ${links.join(', ')}`)

/* -- 3. Log in says who it is for -------------------------------------------- */

/*
  Two adjacent buttons with no distinction invites the wrong one: Register is
  the red accent and dominates visually, so a returning attendee reaches for it
  again and cannot get back to their pass. One line removes the ambiguity.
*/
check(
  'Log in is labelled for people who already registered',
  /Already registered\?/i.test(actions),
  'the caption naming the case is missing',
)
check(
  'the caption points at what Log in does',
  /Already registered\? Log in here\./i.test(actions),
  'the caption no longer names the action',
)
check(
  'the caption is inside the hero, next to the buttons',
  /id="hero-actions"[\s\S]{0,1600}Already registered\?/i.test(actions),
  'the caption is somewhere else on the page',
)
check(
  'the caption is not nonsense for a signed-in visitor',
  /signedIn[\s\S]{0,200}Registered as/.test(actions),
  'a signed-in visitor is told "Already registered? Log in here." next to their own pass',
)

/*
  The caption must fit on one line at 342px. The two-line version ended at
  700px — below a 667px fold — so the note explaining Log in was itself
  invisible on the smallest phone it was written for.
*/
const caption = actions.slice(actions.indexOf('Already registered'))
check(
  'the caption is short enough to stay on one line',
  /Log in here\./.test(caption) && !/to open your pass/.test(caption),
  'the caption grew back to two lines',
)

/* -- 3b. the hero is short enough for the CTAs to clear a phone ------------- */

/*
  Removing the masthead link put the burden on the hero itself. With the
  original mobile padding the buttons sat at 640-704px, so "Log in" was 37px
  below a 667px fold — the problem would have persisted with a different cause.
  `sm:` must restore the desktop rhythm, or this quietly changes the design the
  desktop layout was approved on.
*/
check(
  'the hero padding steps down on phones',
  /px-6 py-8 sm:px-10 sm:py-16/.test(actions),
  'mobile padding is not reduced, so the CTAs fall below the fold again',
)
check(
  'the actions margin steps down on phones',
  /mt-6 flex flex-row gap-2 sm:mt-10 sm:gap-4/.test(actions),
  'the actions margin is not reduced on mobile',
)
check(
  'the facts margin steps down on phones',
  /mt-6 grid grid-cols-2 gap-px[^\n]*?sm:mt-8/.test(actions),
  'the facts block still pushes the buttons down on a phone',
)

/* -- 4. the programme is not on the landing page ---------------------------- */

/*
  The agenda moved off the landing page to the attendee dashboard, where it is
  grouped by day the same way. A public page that lists every session competes
  with the one decision it exists to make: register, or log in.

  It must not come back here, and must not have been deleted outright — the
  dashboard is the only place that should render it.
*/
check(
  'the landing page renders no programme',
  !/agenda/.test(view) && !/Programme/i.test(view),
  'the programme is back on the landing page',
)
check(
  'there is no dead Details component left behind',
  !/function Details/.test(view),
  'an unused Details() survived the removal',
)
const panel = readCode('src/components/EventStatusPanel.tsx')
check(
  'the programme still exists on the attendee dashboard',
  /event\.agenda/.test(panel),
  'the programme was deleted rather than moved',
)

/* -- 5. the masthead is a mark and nothing else ----------------------------- */

check(
  'the masthead carries no sign-in link',
  !/<header[\s\S]{0,900}to="\/login"/.test(view),
  'the top-right Log in is back, which was asked to be removed',
)

/* -- 6. the auth verb is "log", everywhere ----------------------------------- */

/*
  A house rule, and one that was quietly broken in five places: the admin login's
  cross-link read "Attendee sign in", both mastheads said "Signed in", both logout
  buttons said "Sign out", and the attendee remember-me checkbox said "Keep me
  signed in". None of them was a functional bug, which is exactly why they survived
  — nothing fails when the verb changes.

  So it is asserted across `src/` rather than eyeballed. Comments are stripped
  first, because the comments that *explain* this rule necessarily quote the banned
  phrases, and matching those would make the check impossible to satisfy.
*/
const BANNED = /\bsign(?:ed)?\s+(?:in|out|on)\b/i

for (const file of walk('src')) {
  const body = readCode(file)
  if (!body) continue

  const hit = body.split('\n').find((line) => BANNED.test(line))
  check(
    `"${file}" uses "log in / log out", never "sign in"`,
    !hit,
    hit ? `found: ${hit.trim().slice(0, 70)}` : undefined,
  )
}

/* -- 7. a render crash cannot blank the site --------------------------------- */

/*
  React unmounts the whole tree when a component throws while rendering, so without
  a boundary any single bad render is a permanent white screen: no explanation, no
  navigation, nothing in the console unless DevTools happens to be open. On a phone
  at a registration desk that is indistinguishable from the whole site being down.

  Verified by deliberately crashing `LandingView` and loading the built bundle —
  the recovery panel rendered and the error reached the console. What is asserted
  here is that the wiring survives, because an unused boundary is one refactor away
  from being deleted, and it only fails on the day it is needed.
*/
const main = readCode('src/main.tsx')
const boundary = readCode('src/components/ErrorBoundary.tsx')

check(
  'the app is wrapped in an error boundary',
  /BoundaryGate/.test(main) && /<BoundaryGate>/.test(main),
  'a render throw would unmount everything and leave a white page',
)
check(
  'the boundary sits above the providers, not inside them',
  main.indexOf('<BoundaryGate>') < main.indexOf('<AttendeeProvider>'),
  'a throw inside a provider would escape the boundary',
)
check(
  'the boundary is inside the Router so it can recover on navigation',
  main.indexOf('<BrowserRouter>') < main.indexOf('<BoundaryGate>'),
  'the boundary cannot read the route, so it stays broken after navigating away',
)
check(
  'the boundary catches rather than re-throwing',
  /getDerivedStateFromError/.test(boundary) && /componentDidCatch/.test(boundary),
  'a boundary missing a lifecycle hook renders nothing at all',
)
check(
  'the boundary offers a way out of both doors',
  /to="\/login"/.test(boundary) && /to="\/admin"/.test(boundary),
  'someone locked out of one portal cannot reach the other',
)
check(
  'the boundary shows no internals',
  !/error\.message|error\.stack/.test(boundary),
  'the recovery panel is leaking a stack trace to the attendee',
)

/* -- 8. the guest-list refusal tells someone what to do -------------------- */

/*
  When registration is restricted, a student who is not on the list is refused at the
  form with no self-service route to fix it. The server deliberately sends no
  `message` for that — `ApiError` defaults it to the code and the handler omits a
  redundant one — so the copy they actually read is this string. If it does not name
  the contact address, the only outcome is a dead end and an abandoned registration.

  Asserted here because `test:guestlist` can only check the CODE: the human wording
  lives on the client and is never on the wire.
*/
const portalTypes = readCode('src/domain/types.ts')
check(
  'the not-on-list message names the contact address',
  /not_on_list:[\s\S]{0,220}@/.test(portalTypes),
  'the refusal would leave a student with nowhere to go',
)
check(
  'the not-on-list message says the list exists, rather than denying registration',
  /not_on_list:[\s\S]{0,120}guest list/i.test(portalTypes),
  'the copy must distinguish "not on the list" from "not registered"',
)

/* -- 9. touch targets are unharmed ------------------------------------------ */

/*
  Three CTAs now, not two: "Your pass" for a signed-in visitor alongside the
  anonymous "Register" / "Log in" pair. All three must stay `size="lg"` — the
  fold arithmetic in the README assumes 64px buttons, and dropping one to `md`
  would silently move the row.
*/
const lgButtons = count(actions, /size="lg"/g)
check(
  'every hero CTA is size lg (64px)',
  lgButtons === 3,
  `${lgButtons} size="lg" buttons; the layout arithmetic assumes three 64px targets`,
)
check(
  'no undersized button size is left in the system',
  !/^\s*sm:\s*'h-/m.test(button),
  'a `sm` size with no consumer is dead API surface',
)

/* -- 7. the footer ---------------------------------------------------------- */

/*
  The footer carries real destinations and a real credit, so it is worth pinning:
  a typo in a mailto or a dropped `rel="noreferrer"` is invisible in a screenshot
  and only noticed when someone clicks it at the event.
*/
const footer = readCode(FOOTER)

check('the footer exists', /export function SiteFooter/.test(footer))
check('the landing page renders it', /<SiteFooter\s*\/>/.test(view))
/*
  The host block has to be the grid's FIRST child, not merely present somewhere —
  the reference this follows puts the university hard left, and swapping the two
  columns is exactly the kind of change that looks fine in code review.
  The heading is matched rather than the university name because the component
  renders `{HOST.name}`; the literal only exists in the constant above it.
*/
check(
  'the host block is the far-left column',
  /className="grid gap-10 sm:grid-cols-2 lg:gap-16"[\s\S]{0,320}Hosted by/.test(footer),
  'the host block is not the first column of the footer grid',
)
check(
  'the connect list sits in the second column',
  /Hosted by[\s\S]{0,3000}Connect/.test(footer),
  'the Connect column is missing or precedes the host block',
)

for (const [label, needle] of [
  ['the GDG LinkedIn', 'linkedin.com/company/gdgoc-aub'],
  ['the lead developer LinkedIn', 'linkedin.com/in/hb-mrudhal-ankith-9834a23a2'],
  ['the Amity official site', 'amity.edu/bengaluru'],
]) {
  check(`${label} is linked`, footer.includes(needle), `${needle} missing`)
}

/*
  The footer and the password help both need this address, so it lives in
  `src/domain/contact.ts` and both import it.

  An earlier version of this assertion required the literal to appear in the
  footer itself, which is what pushed the same address into two files — and two
  literals is how one of them ends up pointing at an inbox nobody reads. The check
  is now: the footer builds its mailto from the shared constant, and the constant
  really is the organiser's address.
*/
const contact = readCode('src/domain/contact.ts')

check(
  'contact us opens the organiser mail client',
  /mailto:\$\{CONTACT_EMAIL\}/.test(footer) &&
    /CONTACT_EMAIL = 'ankith2409@gmail\.com'/.test(contact),
  'the mailto is not wired to the organiser address',
)
check(
  'the lead developer is credited',
  /Built by/.test(footer) && /HB Mrudhal Ankith/.test(footer),
  'the built-by credit is missing',
)
check(
  'there is a copyright line',
  /© 2026/.test(footer),
)

/*
  External links must carry `rel="noreferrer noopener"`. Without it the target
  page gets `window.opener` and can navigate this tab — a real risk on a page
  with a session cookie, and the kind of thing that ships because the link
  looked fine in review.
*/
check(
  'external links open safely in a new tab',
  /target: '_blank', rel: 'noreferrer noopener'/.test(footer),
  'a new-tab link is missing rel="noreferrer noopener"',
)
check(
  'the mail link does not force a new tab',
  /isMail \? \{\} : \{ target/.test(footer),
  'mailto links should not carry target="_blank"',
)
check(
  'external links are marked as leaving the site',
  /ExternalMark/.test(footer) && /aria-hidden="true"/.test(footer),
)

/* -- 8. the hero labels read institutionally -------------------------------- */

check(
  'the facts use institutional labels, not form-field labels',
  /'Date'/.test(actions) && /'Venue'/.test(actions) && /'Hosted by'/.test(actions),
  'the Date / Venue / Hosted by labels are missing',
)
check(
  'the conversational labels are gone',
  !/'When'/.test(actions) && !/'Where'/.test(actions) && !/'Host'/.test(actions),
  '"When" / "Where" / "Host" still read like form fields',
)

report()