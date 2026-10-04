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
import { testSen, purgeTestAttendeesOnce } from './_fixtures.mjs'

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
    body: body === undefined ? undefined : JSON.stringify(body),
  })
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
    password: adminPassword ?? '',
  })
  check('admin signs in', admin.status === 200, `got ${admin.status}`)
  if (admin.status !== 200) {
    console.log(`\n  ${passed} passed, ${failed} failed\n`)
    process.exitCode = 1
    return
  }

  /* -- register one attendee to collide with ------------------------------- */
  const stamp = Date.now().toString().slice(-7)
  const phone = `9${stamp}`.padEnd(10, '0').slice(0, 10)
  // ZTEST-prefixed so the cleanup at the end can find and remove it. This used to
  // be `A866175<stamp>` — a SEN shaped exactly like a real Amity one, which is
  // both unrecognisable to any cleanup rule and dangerous to leave lying about.
  const sen = testSen(`COPY${stamp}`)

  const first = await call('POST', '/api/attendee/register', {
    name: 'COPYPROBE One', phone, sen, password: 'grid2026',
  })
  check('registers the probe attendee', first.status === 201, `got ${first.status}`)

  /* -- the codes that previously leaked ------------------------------------ */

  // `phone_taken` / `sen_taken` — thrown with no message, so `message` used to
  // default to the code and beat PORTAL_ERROR_MESSAGES in the client.
  const dupePhone = await call('POST', '/api/attendee/register', {
    name: 'COPYPROBE One', phone, sen: `${sen}X`, password: 'grid2026',
  })
  check('duplicate phone returns 409', dupePhone.status === 409, `got ${dupePhone.status}`)
  check('duplicate phone omits the redundant message',
    dupePhone.json.message === undefined, `message=${JSON.stringify(dupePhone.json.message)}`)
  check('duplicate phone renders as human copy',
    rendered(dupePhone.json) === PORTAL_ERROR_MESSAGES.phone_taken,
    `rendered "${rendered(dupePhone.json)}"`)
  check('duplicate phone does not render as a machine code',
    rendered(dupePhone.json) !== 'phone_taken', `rendered "${rendered(dupePhone.json)}"`)

  const dupeSen = await call('POST', '/api/attendee/register', {
    name: 'COPYPROBE Two', phone: `8${stamp}`.padEnd(10, '0').slice(0, 10), sen, password: 'grid2026',
  })
  check('duplicate SEN returns 409', dupeSen.status === 409, `got ${dupeSen.status}`)
  check('duplicate SEN omits the redundant message',
    dupeSen.json.message === undefined, `message=${JSON.stringify(dupeSen.json.message)}`)
  check('duplicate SEN renders as human copy',
    rendered(dupeSen.json) === PORTAL_ERROR_MESSAGES.sen_taken,
    `rendered "${rendered(dupeSen.json)}"`)

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
  check('first scan marks attendance', scanOne.status === 201, `got ${scanOne.status}`)

  const scanTwo = await call('POST', '/api/admin/attendance', { sen }, admin.cookie)
  check('second scan is refused', scanTwo.status === 409, `got ${scanTwo.status}`)
  check('second scan omits the redundant message',
    scanTwo.json.message === undefined, `message=${JSON.stringify(scanTwo.json.message)}`)
  check('second scan renders as human copy',
    rendered(scanTwo.json) === PORTAL_ERROR_MESSAGES.already_checked_in,
    `rendered "${rendered(scanTwo.json)}"`)
  check('second scan does not render as a machine code',
    rendered(scanTwo.json) !== 'already_checked_in', `rendered "${rendered(scanTwo.json)}"`)

  /* -- deliberate wording must survive ------------------------------------- */

  // A 404 that DOES carry copy must keep it, or the fix would have flattened
  // every specific message into the generic one.
  const ghost = await call('GET', '/api/no/such/endpoint', undefined, admin.cookie)
  check('unknown endpoint is a 404', ghost.status === 404, `got ${ghost.status}`)
  check('unknown endpoint keeps its specific wording',
    ghost.json.message === 'No such endpoint.',
    `message=${JSON.stringify(ghost.json.message)}`)

  // Likewise for a validation failure, which has the most useful copy of all.
  const badStatus = await call('PATCH', '/api/admin/agenda/999999', {
    status: 'invented',
  }, admin.cookie)
  check('invalid agenda status is a 400', badStatus.status === 400, `got ${badStatus.status}`)
  check('invalid agenda status keeps its specific wording',
    badStatus.json.message === 'Invalid status.',
    `message=${JSON.stringify(badStatus.json.message)}`)

  /* -- codes that DO carry deliberate wording must keep it ------------------ */

  const badPhone = await call('POST', '/api/attendee/register', {
    name: 'COPYPROBE One', phone: '12345', sen: `${sen}Y`, password: 'grid2026',
  })
  check('short phone still gets its specific wording',
    typeof badPhone.json.message === 'string' && badPhone.json.message.includes('10-digit'),
    `message=${JSON.stringify(badPhone.json.message)}`)

  const badPassword = await call('POST', '/api/attendee/register', {
    name: 'COPYPROBE One', phone: `7${stamp}`.padEnd(10, '0').slice(0, 10),
    sen: `${sen}Z`, password: 'short',
  })
  check('weak password still gets its specific wording',
    typeof badPassword.json.message === 'string' && badPassword.json.message.length > 0,
    `message=${JSON.stringify(badPassword.json.message)}`)

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
