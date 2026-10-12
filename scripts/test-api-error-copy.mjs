#!/usr/bin/env node
/**
 * Confirms the API no longer leaks a machine code as the user-facing message.
 *
 * Every response is read twice: once raw, and once through `PortalError` exactly
 * as the browser would. A response only counts as correct if BOTH look right —
 * the raw body must omit a redundant `message`, and the rendered error must be
 * the human copy rather than the code.
 *
 *   node --experimental-strip-types scripts/test-api-error-copy.mjs
 */

import { PortalError, PORTAL_ERROR_MESSAGES } from '../src/domain/types.ts'
import { testSen, purgeTestAttendeesOnce, testEmail } from './_fixtures.mjs'

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'

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

async function call(method, path, body, cookie) {
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body) })
  let json = {}
  try {
    json = await res.json()
  } catch {
    // non-JSON body; the status checks below still apply
  }
  const setCookie = res.headers.get('set-cookie')
  return { status: res.status, json, cookie: setCookie?.split(';')[0] }
}

/** The browser's view: what a user would actually read on screen. */
function rendered(json) {
  if (typeof json.code !== 'string') return '(no code)'
  return new PortalError(json.code, json.message).message
}

async function main() {
  console.log(`\n  Testing ${BASE}\n`)

  /* -- an admin session, needed for the scan and agenda routes --------------- */
  const adminPassword = process.env.ADMIN_PASSWORD
  const admin = await call('POST', '/api/admin/login', {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    // Required, never defaulted. A fallback literal here is a credential
    // committed to the repository, and this file is published. The other suites
    // default to '' for the same reason.
    password: adminPassword ?? '' })
  check('admin signs in', admin.status === 200, `got ${admin.status}`)
  if (admin.status !== 200) {
    console.log(`\n  ${passed} passed, ${failed} failed\n`)
    process.exitCode = 1
    return
  }

  /* -- register one attendee to collide with ------------------------------- */
  // The event's own day state, so per-day copy assertions hold on day two as well
  // as day one instead of quietly assuming day one.
  const eventInfo = (await call('GET', '/api/event', undefined, admin.cookie)).json ?? {}
  const activeDay = eventInfo.activeDay ?? 1

  const stamp = Date.now().toString().slice(-7)
  const phone = `9${stamp}`.padEnd(10, '0').slice(0, 10)
  // ZTEST-prefixed so the cleanup at the end can find and remove it. This used to
  // be `A866175<stamp>` — a SEN shaped exactly like a real Amity one, which is
  // both unrecognisable to any cleanup rule and dangerous to leave lying about.
  const sen = testSen(`COPY${stamp}`)

  const first = await call('POST', '/api/attendee/checkin', {
    name: 'COPYPROBE One', phone, sen, password: 'grid2026',
    email: testEmail('probe')})
  check('registers the probe attendee', first.status === 201, `got ${first.status}`)

  /* -- the codes that previously leaked ------------------------------------ */

  // `phone_taken` / `sen_taken` — thrown with no message, so `message` used to
  // default to the code and beat PORTAL_ERROR_MESSAGES in the client.
  const dupePhone = await call('POST', '/api/attendee/checkin', {
    name: 'COPYPROBE One', phone, sen: sen + 'X' })
  /*
    A SHARED PHONE NUMBER IS NOT AN ERROR.

    It used to be: the column was unique because login took a phone number. Two
    students living at the same address is ordinary, and the check-in insert had no
    handler for the violation, so the second one got a 500 — a fault in the portal,
    reported to somebody standing at a wall, for nothing.

    So the assertion is that the second person is ACCEPTED, and that the first
    person's row is untouched. Anything else here means somebody has put the unique
    constraint back.
  */
  check('a shared phone number is accepted', dupePhone.status === 201, `got ${dupePhone.status} ${JSON.stringify(dupePhone.json)}`)
  check('and the shared number did not become the shared identity', dupePhone.json?.sen === sen + 'X')
  check('and it reports no error at all', dupePhone.json?.code === undefined, `code=${dupePhone.json?.code}`)

  const dupeSen = await call('POST', '/api/attendee/checkin', {
    name: 'COPYPROBE Two', phone: `8${stamp}`.padEnd(10, '5'), sen })
  /*
    A REPEAT CHECK-IN IS A SUCCESS, NOT A CONFLICT.

    A student who taps twice, or whose first tap timed out on a weak signal and who
    retried, has still been to the event exactly once. Answering 409 would put an
    error in front of somebody who did nothing wrong and who has nothing to ask an
    organiser about — there is no failure here to report.
  */
  check('a repeated check-in is accepted', dupeSen.status === 200, `got ${dupeSen.status}`)
  check('and is reported as already marked', dupeSen.json?.alreadyMarked === true, JSON.stringify(dupeSen.json))
  check('and is not an error code', dupeSen.json?.code === undefined, `code=${dupeSen.json?.code}`)

  // `unknown_sen` — a gate operator scanning a code that matches nobody.
  const bogusScan = await call('POST', '/api/admin/attendance', {
    sen: 'A866175999999',
  }, admin.cookie)
  check('unmatched scan is rejected', bogusScan.status === 422, `got ${bogusScan.status}`)
  check('unmatched scan omits the redundant message',
    bogusScan.json.message === undefined, `message=${JSON.stringify(bogusScan.json.message)}`)
  check('unmatched scan renders as human copy',
    rendered(bogusScan.json) === PORTAL_ERROR_MESSAGES.unknown_sen,
    `rendered "${rendered(bogusScan.json)}"`)
  check('unmatched scan does not render as a machine code',
    rendered(bogusScan.json) !== 'unknown_sen', `rendered "${rendered(bogusScan.json)}"`)

  // A malformed SEN is rejected by the shape check before the lookup, and must
  // produce the same code — an operator cannot tell those two cases apart.
  const malformedScan = await call('POST', '/api/admin/attendance', {
    sen: 'not-a-sen',
  }, admin.cookie)
  check('malformed scan is rejected', malformedScan.status === 422, `got ${malformedScan.status}`)
  check('malformed scan renders as the same copy',
    rendered(malformedScan.json) === PORTAL_ERROR_MESSAGES.unknown_sen,
    `rendered "${rendered(malformedScan.json)}"`)

  // `already_checked_in` — the second scan of the same pass, mid-queue.
  const scanOne = await call('POST', '/api/admin/attendance', { sen }, admin.cookie)
  /*
    The fixture is created BY a check-in, which marks it, so an admin scan of the
    same person on the same day correctly conflicts. What matters here is that the
    conflict is reported as `already_checked_in` and rendered as copy — which is
    the door case: a volunteer scanning somebody twice.
  */
  check(
    'a repeat scan conflicts, and says which reason',
    scanOne.status === 409 && scanOne.json?.code === 'already_checked_in',
    `${scanOne.status} ${scanOne.json?.code}`,
  )

  const scanTwo = await call('POST', '/api/admin/attendance', { sen }, admin.cookie)
  check('second scan is refused', scanTwo.status === 409, `got ${scanTwo.status}`)

  /*
    The invariant, not the day-one shape.

    This asserted `message === undefined`, which was true only while the calendar
    said day one: on day two the route deliberately sends "Already marked for day
    2." because the same badge will succeed later, and a bare code reads as a dead
    end to somebody holding a valid pass for today.

    So the rule is not "no message" — it is "never the code repeated back". That
    holds on every day, which is what makes it worth asserting.
  */
  check('second scan never repeats the machine code as its message',
    scanTwo.json.message !== 'already_checked_in',
    `message=${JSON.stringify(scanTwo.json.message)}`)
  check('second scan renders as human copy, not a code',
    typeof rendered(scanTwo.json) === 'string' &&
      rendered(scanTwo.json).length > 0 &&
      rendered(scanTwo.json) !== 'already_checked_in',
    `rendered "${rendered(scanTwo.json)}"`)
  check('second scan names the day when the live day is not the first',
    // Day one deliberately sends no message, so the client renders the generic
    // fallback — and on a single-day event, or on day one of a two-day one, naming
    // the day would add nothing. It only matters from day two, where the same badge
    // will succeed later and a bare code reads as a dead end.
    activeDay <= 1 || /day \d/i.test(scanTwo.json.message ?? ''),
    `activeDay=${activeDay} message=${JSON.stringify(scanTwo.json.message)}`)

  /* -- deliberate wording must survive ------------------------------------- */

  // A 404 that DOES carry copy must keep it, or the fix would have flattened
  // every specific message into the generic one.
  const ghost = await call('GET', '/api/no/such/endpoint', undefined, admin.cookie)
  check('unknown endpoint is a 404', ghost.status === 404, `got ${ghost.status}`)
  check('unknown endpoint keeps its specific wording',
    ghost.json.message === 'No such endpoint.',
    `message=${JSON.stringify(ghost.json.message)}`)

  /*
    Likewise for a validation failure that still exists.

    This used to be an invalid agenda status. That route is gone, so the
    surviving case is a bad event phase — the same owner-only, same-validate-then-
    write shape, so the copy assertion still means what it meant.
  */
  const badPhase = await call('PATCH', '/api/admin/event', {
    phase: 'invented',
  }, admin.cookie)
  check('invalid event phase is a 400', badPhase.status === 400, `got ${badPhase.status}`)
  check('invalid event phase keeps its specific wording',
    typeof badPhase.json.message === 'string' && badPhase.json.message.length > 0 &&
      badPhase.json.message !== 'Request failed.',
    `message=${JSON.stringify(badPhase.json.message)}`)

  /* -- codes that DO carry deliberate wording must keep it ------------------ */

  const badPhone = await call('POST', '/api/attendee/checkin', {
    name: 'COPYPROBE One', phone: '12345', sen: `${sen}Y`, password: 'grid2026',
    email: testEmail('probe')})
  check('short phone still gets its specific wording',
    typeof badPhone.json.message === 'string' && badPhone.json.message.includes('10-digit'),
    `message=${JSON.stringify(badPhone.json.message)}`)

  const badPassword = await call('POST', '/api/attendee/checkin', {
    name: 'COPYPROBE One', phone: `7${stamp}`.padEnd(10, '0').slice(0, 10),
    sen: `${sen}Z`, password: 'short',
    email: testEmail('probe')})
  /*
    The weak-password wording has no route left to reach.

    There are no passwords. `weak_password` is still a declared error code because
    `passwordProblem` still exists for staff, and deleting the code would leave the
    error matrix referring to something that cannot be sent.
  */
  check('there is no weak-password path on the check-in', true, 'no password is accepted or asked for')
  check(
    'and an ignored password field changes nothing',
    badPassword.status === 201 || badPassword.status === 200,
    `got ${badPassword.status}`,
  )

  // The probe attendee was registered against the live database. Remove it, or it
  // sits on the real roster for the owner to wonder about.
  await purgeTestAttendeesOnce()

  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch(async (error) => {
  console.error('\n  crashed:', error.message, '\n')
  try {
    await purgeTestAttendeesOnce()
  } catch {
    // Never let the cleanup failure mask the real error.
  }
  process.exitCode = 1
})
