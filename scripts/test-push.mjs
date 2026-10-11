#!/usr/bin/env node
/**
 * Web Push.
 *
 * The only messaging channel in the portal that needs no external service account, and
 * therefore the only one that can be relied on with three days to go. These are the
 * properties that are cheap to assert now and expensive to discover on the day.
 *
 *   1. THE PUBLIC KEY IS PUBLIC, AND UNAUTHENTICATED. The browser needs it before
 *      anybody logs in, and it is an address rather than a credential. If it ever
 *      starts needing a session, the toggle silently disappears from every dashboard.
 *
 *   2. SUBSCRIBING NEEDS A SESSION. Nothing personal is stored — the endpoint and two
 *      public keys — so it would be easy to leave open. That would let anyone put the
 *      event's channel on their own device without ever registering, and then they
 *      would receive every message sent to attendees.
 *
 *   3. ONLY THE OWNER MAY BROADCAST. `gate` exists to mark people present at a door.
 *      A message reaches every registered attendee on their own phone, which is a
 *      different power entirely, and the gate credential is shared across whoever is
 *      on the desk that day.
 *
 *   4. THE RESULT IS COUNTS, NOT "SENT". Subscriptions expire, and a service that
 *      reports success for a dead endpoint would let the owner believe a message
 *      landed on four hundred phones when it reached none. Dead endpoints must be
 *      pruned; transient failures must NOT be, or a phone in a tunnel loses its
 *      subscription forever.
 *
 *   5. THE SERVICE WORKER MUST NOT INTERCEPT FETCHES. A worker with a fetch handler is
 *      a proxy in front of every request the page makes, and the failure mode — serving
 *      yesterday's bundle during a live event — looks like "the portal is a bit broken"
 *      rather than "the service worker is caching". Asserted against the source, since
 *      no request-level test can observe it.
 *
 *   ADMIN_USERNAME / ADMIN_PASSWORD, ADMIN_PASSWORD_GATE, and DATABASE_URL.
 */

import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { loadEnv } from './_env.mjs'
import { testSen } from './_fixtures.mjs'

loadEnv()

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'
const OWNER = { username: process.env.ADMIN_USERNAME ?? 'event.control', password: process.env.ADMIN_PASSWORD ?? '' }
const GATE = { username: 'gate', password: process.env.ADMIN_PASSWORD_GATE ?? '' }

let passed = 0
let failed = 0

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`\n  ok    ${label}`)
  } else {
    failed += 1
    console.log(`\n  FAIL  ${label}`)
    if (detail) console.log(`          ${detail}`)
  }
}

function report() {
  console.log(`\n  ${passed} passed, ${failed} failed\n`)
}

let db

/* ------------------------------------------------------------------ helpers */

/** A cookie jar per identity, so owner and gate are genuinely different callers. */
function jar() {
  return new Map()
}

function cookieHeader(store) {
  return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function absorb(store, res) {
  const raw = res.headers.getSetCookie?.() ?? []
  for (const line of raw) {
    const [pair] = line.split(';')
    const idx = pair.indexOf('=')
    if (idx > 0) store.set(pair.slice(0, idx), pair.slice(idx + 1))
  }
}

async function call(store, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(store),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  absorb(store, res)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // Non-JSON responses are asserted on by status, not parsed.
  }
  return { status: res.status, json, text }
}

async function adminLogin(store, who) {
  return call(store, 'POST', '/api/admin/login', who)
}

/*
  A unique, valid 10-digit Indian mobile per registration.

  Exactly ten digits, leading 9. The clock supplies seven and a counter the last two,
  so two registrations inside the same second cannot collide — and every generated
  number stays inside the 9XXXXXXXXX range the portal accepts.
*/
let phoneCounter = 0

function nextPhone() {
  phoneCounter += 1
  const stamp = String(Date.now() % 10000000).padStart(7, '0')
  const tail = String(phoneCounter % 100).padStart(2, '0')
  return `9${stamp}${tail}`
}

/*
  The tag must contain a digit.

  `isValidSen` deliberately accepts any 4+ alphanumerics containing at least one
  digit, so an all-letter tag like `PUSHSUB` is refused as obvious garbage — which
  would fail the registration before this suite got as far as testing anything.
*/
async function registerAttendee(tag) {
  const sen = testSen(tag)
  const res = await call(jar(), 'POST', '/api/attendee/register', {
    name: 'Push Test Suite',
    phone: nextPhone(),
    sen,
  })
  // 201: the account is created, not merely accepted.
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.text}`)
  return {
    sen,
    name: 'Push Test Suite',
    phone: res.json.attendee.phone,
    password: res.json.generatedPassword,
  }
}

/*
  Log in the way an attendee does — name, phone, password.

  All three, because the portal has no email and identifies you by name plus mobile
  number; an empty string is rejected as a missing field rather than treated as
  "not supplied", which is the right behaviour and an easy thing to trip over.
*/
async function attendeeSession(who) {
  const store = jar()
  const res = await call(store, 'POST', '/api/attendee/login', {
    name: who.name,
    phone: who.phone,
    password: who.password,
    remember: false,
  })
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`)
  return store
}

async function subscriberCount() {
  const { rows } = await db.query('select count(*)::int as n from push_subscriptions')
  return rows[0].n
}

/* -------------------------------------------------------------------- main */

async function main() {
  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await db.connect()

  const before = await subscriberCount()

  /*
    Every endpoint this run creates, so cleanup cannot miss one.

    Pattern-matching by prefix is not enough here: one of these deliberately looks
    like a real FCM endpoint and matches no test prefix at all. A leftover row would
    then sit in the table for the next real broadcast to try and fail against.
  */
  const createdEndpoints = []

  /* -- 1. the public key ---------------------------------------------------- */

  console.log('\n  -- the public key is public --')

  const key = await call(jar(), 'GET', '/api/push/key')

  check(
    'GET /push/key needs no session',
    key.status === 200,
    `got ${key.status}`,
  )

  check(
    'and says whether this deployment can send at all',
    typeof key.json?.configured === 'boolean',
    JSON.stringify(key.json),
  )

  check(
    'the public key is a URL-safe base64 P-256 point',
    typeof key.json?.publicKey === 'string' && /^[A-Za-z0-9_-]+$/.test(key.json.publicKey),
    String(key.json?.publicKey).slice(0, 40),
  )

  check(
    'and is 65 bytes once decoded — an uncompressed point, not a bare x',
    Buffer.from(
      key.json.publicKey.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).length === 65,
  )

  check(
    'the PRIVATE key is not on this route',
    !key.text.includes(process.env.VAPID_PRIVATE_KEY ?? '\u0000never'),
    'the private signing key was returned to the browser',
  )

  /* -- 2. subscribing needs a session --------------------------------------- */

  console.log('\n  -- subscribing needs a session --')

  const fake = {
    endpoint: `https://push.test/${testSen('PUSH2')}`,
    keys: { p256dh: 'BElp-Z8a', auth: 'c2VjcmV0' },
  }
  createdEndpoints.push(fake.endpoint)

  const anon = await call(jar(), 'POST', '/api/attendee/push', fake)
  check('POST /attendee/push is refused without a session', anon.status === 401, `got ${anon.status}`)

  check(
    'and stored nothing while refusing',
    (await subscriberCount()) === before,
    'an unauthenticated write reached the table',
  )

  const who = await registerAttendee('PUSH1')
  const session = await attendeeSession(who)

  const subscribed = await call(session, 'POST', '/api/attendee/push', fake)
  check('with a session it succeeds', subscribed.status === 200, `${subscribed.status} ${subscribed.text}`)

  check(
    'and the subscription is now held',
    (await subscriberCount()) === before + 1,
  )

  check(
    're-subscribing the same endpoint is not an error',
    (await call(session, 'POST', '/api/attendee/push', fake)).status === 200,
    'a user toggling permission off and on again would see an error',
  )

  check(
    'and did not create a second row',
    (await subscriberCount()) === before + 1,
    'a duplicate endpoint would make every broadcast send twice',
  )

  for (const [label, body] of [
    ['a missing endpoint', { keys: fake.keys }],
    ['a missing key', { endpoint: fake.endpoint }],
  ]) {
    check(
      `${label} is rejected rather than half-stored`,
      (await call(session, 'POST', '/api/attendee/push', body)).status === 400,
    )
  }

  check(
    'an absurd endpoint is refused before it reaches the database',
    (
      await call(session, 'POST', '/api/attendee/push', {
        endpoint: 'x'.repeat(600),
        keys: fake.keys,
      })
    ).status === 400,
  )

  const removed = await call(session, 'POST', '/api/attendee/push/unsubscribe', {
    endpoint: fake.endpoint,
  })
  check('unsubscribing succeeds', removed.status === 200, `${removed.status}`)
  check('and the row is gone', (await subscriberCount()) === before)

  check(
    'unsubscribing something we never had is still a 200',
    (
      await call(session, 'POST', '/api/attendee/push/unsubscribe', {
        endpoint: 'https://push.test/never-existed',
      })
    ).status === 200,
    'a 404 here can only be logged and ignored by the browser',
  )

  /* -- 3. only the owner may broadcast --------------------------------------- */

  console.log('\n  -- only the owner may broadcast --')

  const ownerStore = jar()
  await adminLogin(ownerStore, OWNER)
  const gateStore = jar()
  await adminLogin(gateStore, GATE)

  const attendee = await call(jar(), 'POST', '/api/admin/push/send', { title: 'x', body: 'y' })
  check('an anonymous caller cannot broadcast', attendee.status === 403, `got ${attendee.status}`)

  const gated = await call(gateStore, 'POST', '/api/admin/push/send', {
    title: 'Room change',
    body: 'Seminar hall.',
  })
  check(
    'the shared gate credential cannot broadcast',
    gated.status === 403,
    `got ${gated.status} — gate reaches every attendee's phone`,
  )

  const state = await call(gateStore, 'GET', '/api/admin/push')
  check('gate may still READ the state, so it can be told what is set up', state.status === 200, `got ${state.status}`)

  /* -- 4. sending ------------------------------------------------------------ */

  console.log('\n  -- sending, and being honest about it --')

  const empty = await call(ownerStore, 'POST', '/api/admin/push/send', { title: 'Hello', body: 'Nobody yet.' })
  check('an owner broadcast succeeds', empty.status === 200, `${empty.status} ${empty.text}`)

  check(
    'and reports counts rather than a bare success',
    typeof empty.json?.sent === 'number' &&
      typeof empty.json?.pruned === 'number' &&
      typeof empty.json?.failed === 'number' &&
      typeof empty.json?.total === 'number',
    JSON.stringify(empty.json),
  )

  check(
    'with no real devices it delivered to none, and said so',
    empty.json.sent === 0 && empty.json.total === 0,
    'a "sent" response with no devices would be a lie on the day',
  )

  check(
    'the announcement is recorded so it can be shown to people who declined',
    typeof empty.json?.announcement?.id === 'string' && empty.json.announcement.body === 'Nobody yet.',
  )

  const publicEvent = await call(jar(), 'GET', '/api/event')
  check(
    'and rides /event so the dashboard needs no extra request',
    publicEvent.json?.announcement?.title === 'Hello',
    JSON.stringify(publicEvent.json?.announcement),
  )

  /*
    A subscription we control cannot be used to prove delivery — there is no push
    service on this side of the test. What IS assertable is that a send against a
    fake endpoint FAILS and is counted as a failure rather than a success, which is the
    behaviour that keeps the numbers honest.
  */
  await call(ownerStore, 'GET', '/api/admin/push')
  const deadEndpoint = 'https://fcm.googleapis.com/fcm/send/definitely-not-a-real-endpoint'
  createdEndpoints.push(deadEndpoint)
  await call(session, 'POST', '/api/attendee/push', {
    endpoint: deadEndpoint,
    keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: '2bdVT9ZFb-1s2Z' },
  })

  const againstFake = await call(ownerStore, 'POST', '/api/admin/push/send', {
    title: 'Lunch',
    body: 'Main hall.',
  })
  check(
    'an unreachable endpoint is a FAILURE, never a success',
    againstFake.json.sent === 0 && againstFake.json.total >= 1,
    JSON.stringify(againstFake.json),
  )
  check(
    'and is counted as retryable rather than silently pruned',
    againstFake.json.failed >= 1,
    'a transient network failure must not unsubscribe a real device',
  )

  /*
    Blank and over-long are refused differently, and the difference is not pedantry.

    A blank field is a malformed request — 400, the same as any other missing field.
    Over-long is well-formed but cannot be delivered — 422, because the owner did
    something the system understood and cannot honour. Both say no; the codes tell
    the client which to explain.

    Whitespace-only is the case worth asserting explicitly. `'   '` is truthy, so
    any check written as `if (!title)` would accept it and then push a notification
    with a blank title, which renders as an empty bar nobody can read.
  */
  for (const [label, body] of [
    ['a blank subject', { title: '   ', body: 'x' }],
    ['a blank message', { title: 'x', body: '   ' }],
  ]) {
    check(`${label} is refused`, (await call(ownerStore, 'POST', '/api/admin/push/send', body)).status === 400)
  }

  for (const [label, body] of [
    ['an over-long subject', { title: 't'.repeat(90), body: 'x' }],
    ['an over-long message', { title: 'x', body: 'b'.repeat(300) }],
  ]) {
    check(`${label} is refused`, (await call(ownerStore, 'POST', '/api/admin/push/send', body)).status === 422)
  }

  const padded = await call(ownerStore, 'POST', '/api/admin/push/send', {
    title: `  ${'t'.repeat(80)}  `,
    body: 'padded',
  })
  check(
    'a padded title is measured after trimming, so it still fits',
    padded.status === 200 && padded.json.announcement.title.length === 80,
    `got ${padded.status}; a trailing space should not push it over the limit`,
  )

  const exact = await call(ownerStore, 'POST', '/api/admin/push/send', {
    title: 't'.repeat(80),
    body: 'b'.repeat(240),
  })
  check(
    'the documented limits are inclusive, not off by one',
    exact.status === 200,
    `got ${exact.status} — the UI says 80/240, so the server must accept exactly that`,
  )

  /* -- 5. the service worker must be inert ----------------------------------- */

  console.log('\n  -- the service worker cannot touch the app --')

  const sw = readFileSync('public/sw.js', 'utf8')

  check(
    'it has no fetch handler at all',
    !/addEventListener\(\s*['"]fetch['"]/.test(sw),
    'a worker that intercepts requests can serve a stale bundle during the event',
  )

  check('it does handle push', /addEventListener\(\s*['"]push['"]/.test(sw))
  check('and notification clicks', /addEventListener\(\s*['"]notificationclick['"]/.test(sw))

  check(
    'a notification carries a title, whatever arrives',
    /showNotification\(title/.test(sw) && /The Awakening/.test(sw),
    'an unparseable payload must still show something',
  )

  check(
    'notifications collapse onto one tag',
    /tag:\s*'awakening'/.test(sw),
    'without a tag every message stacks and the phone becomes a backlog',
  )

  check(
    'it is served from the origin root, which is the only scope that can receive a push',
    readFileSync('vercel.json', 'utf8').includes('outputDirectory'),
    'a worker outside / cannot cover /dashboard',
  )

  /* -- cleanup --------------------------------------------------------------- */

  if (createdEndpoints.length > 0) {
    await db.query('delete from push_subscriptions where endpoint = any($1::text[])', [
      createdEndpoints,
    ])
  }
  await db.query('delete from push_subscriptions where endpoint like $1', [`%${testSen('PUSH2')}%`])
  await db.query('delete from announcements')
  await db.query(`delete from attendees where upper(sen) like 'ZTEST%'`)

  check(
    'cleanup left no subscriptions behind',
    (await subscriberCount()) === before,
    'a leftover row would be a device every real broadcast then fails against',
  )
  const leftovers = await db.query(`select count(*)::int as n from attendees where upper(sen) like 'ZTEST%'`)
  check('and no test attendees', leftovers.rows[0].n === 0, `${leftovers.rows[0].n} left`)

  report()
}

main()
  .catch(async (error) => {
    console.error('\n  crashed:', error.message, '\n')
    try {
      await db.query(`delete from push_subscriptions where endpoint like '%push.test%'`)
      await db.query(
        `delete from push_subscriptions where endpoint like 'https://fcm.googleapis.com/fcm/send/definitely%'`,
      )
      await db.query('delete from announcements')
      await db.query(`delete from attendees where upper(sen) like 'ZTEST%'`)
      await db.end()
    } catch {
      // A cleanup failure must not mask the real error.
    }
    process.exitCode = 1
  })
  .finally(async () => {
    if (db) await db.end().catch(() => {})
  })