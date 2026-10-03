#!/usr/bin/env node
/**
 * Reproduces the hang: an API request that never settles.
 *
 * `#request` in `src/api/http-portal.ts` calls `fetch` with no `signal`. `fetch`
 * has no default timeout, so a connection that stalls — weak venue wifi, mobile
 * data dropping, a captive portal that accepts the socket and never answers —
 * leaves the promise pending forever.
 *
 * That is fatal on the session probe specifically. `AttendeeProvider` only sets a
 * status in `.then` or `.catch`; if neither ever runs, `status` stays
 * `'initialising'`, and `Guard` renders the boot screen. The attendee is stuck on
 * "VERIFYING SESSION…" with no way to reach the sign-in form.
 *
 * This stands up a server that accepts the request and never responds, then
 * races a real `fetch` against a 3-second timer. If the fetch loses the race, the
 * request would hang indefinitely in the browser.
 *
 *   node scripts/repro-hanging-fetch.mjs
 */

import { createServer } from 'node:http'

const HANG_PORT = 4599

// Accepts the connection, reads nothing, answers nothing. Deliberately never
// ends the response.
const server = createServer(() => {
  /* intentionally silent */
})

await new Promise((resolve) => server.listen(HANG_PORT, resolve))

const url = `http://127.0.0.1:${HANG_PORT}/api/attendee/session`

console.log(`\n  Hanging endpoint: ${url}\n`)

/* What the app does today: no signal, so no timeout. */
const asShipped = fetch(url, { credentials: 'include' })

/* What the fix does. */
const withTimeout = fetch(url, {
  credentials: 'include',
  signal: AbortSignal.timeout(1500),
})

const race = (label, promise, ms) =>
  Promise.race([
    promise.then(
      () => `${label}: RESOLVED`,
      (error) => `${label}: REJECTED (${error.name})`,
    ),
    new Promise((resolve) => setTimeout(() => resolve(`${label}: STILL PENDING after ${ms}ms`), ms)),
  ])

const results = await Promise.all([race('as shipped ', asShipped, 3000), race('with timeout', withTimeout, 3000)])
for (const line of results) console.log(`  ${line}`)

server.close()

const shippedHangs = results[0].includes('STILL PENDING')
const timeoutWorks = results[1].includes('REJECTED')

console.log(`\n  as shipped hangs forever: ${shippedHangs ? 'YES — the bug is real' : 'no'}`)
console.log(`  AbortSignal.timeout rejects:  ${timeoutWorks ? 'yes' : 'NO'}`)
console.log(
  shippedHangs && timeoutWorks
    ? '\n  Confirmed: the missing signal is what turns a bad connection into a\n' +
      '  permanent boot screen, and AbortSignal.timeout is the fix.\n'
    : '\n  Inconclusive — do not trust this run.\n',
)

process.exit(shippedHangs && timeoutWorks ? 0 : 1)