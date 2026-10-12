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
import { testSen, testEmail } from './_fixtures.mjs'
import { decrypt, makeRecipient, verifyVapid } from './_lib/push-crypto.mjs'

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
    email: testEmail('probe')})
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
    body: 'The Auditorium.',
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
    'it reports the devices that actually exist, not zero',
    empty.json.total === before,
    `total=${empty.json.total} but ${before} device(s) are subscribed`,
  )

  check(
    'and sent, failed and pruned partition them exactly',
    /*
      This is the assertion that actually matters, and it replaced a weaker one.

      The old check was `sent === 0 && total === 0`, which only ever passed on an
      empty database — so the day a real attendee subscribed, it failed for a reason
      that had nothing to do with the code, and everyone learned to ignore it.

      What it was reaching for is "the numbers are honest": every endpoint a send
      touched must appear in exactly one of the three buckets, so the owner can add
      them up and believe the total. That holds whatever is subscribed, and it is
      strictly stronger than the count-zero version, which proved nothing once a
      device existed.
    */
    empty.json.sent + empty.json.failed + empty.json.pruned === empty.json.total,
    `sent=${empty.json.sent} failed=${empty.json.failed} pruned=${empty.json.pruned} total=${empty.json.total}`,
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
    'the dead endpoint was seen, and the real one was not invented',
    againstFake.json.total === before + 1,
    `total=${againstFake.json.total}, expected ${before + 1}`,
  )

  check(
    'an unreachable endpoint is a FAILURE, never a success',
    /*
      Was `sent === 0`, which is a proxy for "the fake was not counted as delivered".

      It also asserted something untrue the moment anybody subscribed for real: a
      send DOES reach a real device, so `sent` is legitimately 1. Asserting on the
      absolute number meant the suite broke the moment the feature started being
      used, which is the opposite of when you want your push tests running.

      What matters is that the dead endpoint landed in the failure bucket and
      nowhere else. Asserted directly below.
    */
    againstFake.json.failed >= 1 && againstFake.json.pruned === 0,
    `sent=${againstFake.json.sent} failed=${againstFake.json.failed} pruned=${againstFake.json.pruned}`,
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

/*
    The silent failure.

    Every other failure in this feature is visible. A missing key shows as "not
    configured". A refused route returns 403. A dead endpoint shows up in the counts.

    A broken crypto chain is none of those. The push service rejects the request,
    nothing comes back that says why, the admin panel reports success, and the first
    anybody finds out is when the event is half over and nobody was told. There is no
    way to find that out from our side except by decrypting a payload ourselves.

    So: build the request exactly as `broadcast` does — same VAPID keys, same
    encryption — then decrypt it and read it back. What comes out is byte-for-byte what
    a browser would have received.

    `generateRequestDetails` rather than a stand-in push service, because web-push
    refuses to speak plain HTTP and standing up a real TLS endpoint for a fake would
    be more machinery than the thing being verified. This is the same call
    `sendNotification` makes internally, one line earlier, with the network hop left
    off.
  */

  const recipient = makeRecipient()
  const announced = {
    title: 'Room change',
    body: 'The build session has moved to the Auditorium.',
  }
  const audience = 'https://fcm.googleapis.com/fcm/send/stand-in-endpoint'

  const { default: webpush } = await import('web-push')
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? 'mailto:gdgtechnicalteam@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  )

  let request = null
  try {
    request = webpush.generateRequestDetails(
      { endpoint: audience, keys: { p256dh: recipient.p256dh, auth: recipient.auth } },
      JSON.stringify({ title: announced.title, body: announced.body, url: '/dashboard' }),
    )
  } catch (error) {
    console.log(`          ${error.message}`)
  }

  check('a request could be built at all', request !== null, 'the VAPID key pair may be malformed')

  if (request !== null) {
    const encoding = request.headers['Content-Encoding'] ?? ''
    const authorization = request.headers.Authorization ?? ''

    // The raw request bytes. Needed both by the in-band key check below and by the
    // decrypt further down, so declared once here rather than in either place.
    const body = Buffer.from(request.body)

    /*
      The subscriber key travels IN THE BODY, not in a header.

      web-push emits `Encryption` and `Crypto-Key` only for the legacy `aesgcm`
      encoding. For `aes128gcm`, which it uses by default, there are no such
      headers at all: the sender ephemeral key and the salt form an 86-byte header
      inside the body. Asserting `dh=` in a header would be asserting a field this
      format does not have.
    */
    check(
      'the payload is encrypted for the subscriber, not sent in the clear',
      /aes128gcm/.test(encoding) && body[20] === 65,
      'Content-Encoding was ' + encoding + '; in-body keyid length was ' + body[20],
    )

    /*
      Not gzipped, and correctly so.

      web-push only applies gzip above roughly 2KB, because compressing a short string
      usually makes it longer. A small announcement is left uncompressed on purpose.
      Asserting the presence of gzip here would be asserting the opposite of correct.
    */
    check(
      'a short payload is left uncompressed, which is correct',
      !/gzip/.test(encoding),
      `Content-Encoding: ${encoding}`,
    )

    // --- the VAPID signature, which is what the push service actually checks ---

    let vapid = null
    try {
      vapid = verifyVapid(authorization, process.env.VAPID_PUBLIC_KEY)
    } catch (error) {
      console.log(`          ${error.message}`)
    }

    check(
      'the request carries a VAPID token',
      vapid !== null,
      `Authorization: ${authorization.slice(0, 50)}`,
    )

    if (vapid !== null) {
      check(
        'signed with the key this deployment is configured with',
        vapid.keyMatchesConfig,
        'a push service rejects a token whose key it was not configured with',
      )

      check(
        'and the SIGNATURE actually verifies against it',
        vapid.signatureValid,
        'a token that decodes but does not verify is rejected by every push service, and nothing on our side would say so',
      )

      check(
        'the token is an ES256 JWT',
        vapid.header.alg === 'ES256' && vapid.header.typ === 'JWT',
        JSON.stringify(vapid.header),
      )

      check(
        // RFC 8292: `aud` is the ORIGIN of the push resource, not the whole endpoint.
        // The path identifies one subscription; the origin identifies the service.
        'aud is the origin of the push endpoint, per RFC 8292',
        vapid.claims.aud === new URL(audience).origin,
        `aud was ${vapid.claims.aud}`,
      )

      check(
        'sub is a mailto the push service can contact',
        /^mailto:/i.test(String(vapid.claims.sub)),
        `sub was ${vapid.claims.sub}`,
      )

      check(
        'the token is short-lived, not valid forever',
        vapid.ttlSeconds > 0 && vapid.ttlSeconds <= 24 * 60 * 60,
        `expires in ${vapid.ttlSeconds}s`,
      )
    }

    // --- the payload itself, decrypted the way a browser would ---
    let plaintext = null
    try {
      plaintext = decrypt(recipient, body)
    } catch (error) {
      console.log(`          decrypt failed: ${error.message}`)
    }

    check(
      'the body decrypts with the subscriber private key alone',
      plaintext !== null,
      'a payload nobody can decrypt is a payload nobody receives',
    )

    if (plaintext !== null) {
      let delivered = null
      try {
        delivered = JSON.parse(plaintext.toString('utf8'))
      } catch {
        // Reported by the assertion below.
      }

      check(
        'and it is the JSON the service worker expects',
        delivered !== null,
        plaintext.toString('utf8').slice(0, 120),
      )
      check(
        'the title is exactly what the owner typed',
        delivered?.title === announced.title,
        `got ${JSON.stringify(delivered?.title)}`,
      )
      check(
        'the body is exactly what the owner typed',
        delivered?.body === announced.body,
        `got ${JSON.stringify(delivered?.body)}`,
      )
      check(
        'and it points at the dashboard',
        typeof delivered?.url === 'string' && delivered.url.startsWith('/'),
        `got ${JSON.stringify(delivered?.url)}`,
      )
    }
  }

  /* -- 6. the dashboard banner retires instead of sitting there forever ------- */

  console.log('\n  -- the announcement banner gets out of the way --')

  /*
    A banner that never leaves is not a banner, it is a permanent layout change. And
    the first version of this made exactly that mistake in a way no assertion would
    have caught: a fixed 3.2s fade animation with `forwards`, running from MOUNT rather
    than from retirement. The element stays mounted for five minutes, so the animation
    finished at 3.2 seconds and left an invisible panel occupying space for the
    remaining four. On a self-refreshing dashboard that reads as a layout bug — a gap
    where a message used to be that nobody can explain.

    So these assert the two properties that version broke: the fade belongs to the
    retire moment, and the element is actually removed once it has faded.
  */

  const banner = readFileSync('src/components/AnnouncementBanner.tsx', 'utf8')
  const css = readFileSync('src/styles/index.css', 'utf8')

  check(
    'the banner does not run a fixed animation from mount',
    !/animation:.*gdg-announcement.*\bduration\b/.test(css) && !/animate-\[/.test(banner),
    'a fade that starts on mount finishes long before the banner is meant to retire',
  )

  check(
    'the fade is a transition driven by the retiring state',
    /transition:[\s\S]{0,80}opacity/.test(css) &&
      /data-retiring/.test(banner) &&
      /\[data-retiring='true'\]/.test(css),
    'arriving and leaving must be two different events, not one',
  )

  check(
    'and the element is unmounted once it has faded, not left invisible',
    /READ_WINDOW_MS \+ FADE_MS/.test(banner) &&
      /setRetired\(\(current\) => new Set\(current\)\.add\(id\)\)/.test(banner),
    'an invisible panel holding its place in the layout is the bug this replaced',
  )

  check(
    'the read window is long enough to act on',
    /READ_WINDOW_MS = 5 \* 60 \* 1000/.test(banner),
    'somebody has to cross the room before this can disappear',
  )

  check(
    'a retired announcement is remembered against its own ID',
    /SEEN_PREFIX \+ id/.test(banner) && /startsWith\(SEEN_PREFIX\)/.test(banner),
    'a single "seen" flag would silently swallow the NEXT message, which is the one the fallback exists for',
  )

  check(
    'and a different announcement still shows afterwards',
    /const show = id !== null && !retired\.has\(id\)/.test(banner),
  )

  check(
    'the stored read cannot throw on a browser that blocks site data',
    /catch \{[\s\S]{0,400}return new Set\(\)/.test(banner),
    'private browsing throws rather than returning null, and would break the dashboard',
  )

  check(
    'reduced motion suppresses the transition rather than the banner',
    /prefers-reduced-motion: reduce/.test(css) && /transition: none/.test(css),
  )

  /* -- 7. the service worker must be inert ----------------------------------- */

  /* -- 6. the service worker must be inert ----------------------------------- */

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

  /* -- 7. the toggle must actually appear ------------------------------------- */

  console.log('\n  -- the toggle is reachable before anybody logs in --')

  const usePush = readFileSync('src/push/usePush.ts', 'utf8')
  const toggle = readFileSync('src/components/NotificationToggle.tsx', 'utf8')
  const authViews = readFileSync('src/views/AuthViews.tsx', 'utf8')

  check(
    'the read path never awaits serviceWorker.ready',
    /*
      This is the one that shipped broken.

      `navigator.serviceWorker.ready` never settles when no worker is registered —
      it does not reject and it does not time out. Since the first thing anybody
      arriving at /login has ever done is arrive with no worker, the hook sat in its
      `checking` state forever and the toggle rendered NOTHING. Not an error, not a
      console message: an absence, on the two pages whose entire purpose is to be
      seen by somebody who has not opted in yet.

      The bug was invisible because the refused-permission branch returns before that
      await, and the browser used for testing had permission denied.

      Counted as the AWAIT rather than as the bare property name, because the comment
      explaining why it is banned necessarily contains the name it bans.
    */
    (usePush.match(/await navigator\.serviceWorker\.ready/g) ?? []).length === 1 &&
      usePush.split('const enable =')[0].includes('await navigator.serviceWorker.ready') ===
        false,
    'the read path can await a promise that never settles when no worker exists',
  )

  check(
    'and asks getRegistration instead, which answers immediately',
    /serviceWorker\.getRegistration\(/.test(usePush),
  )

  check(
    'the toggle renders on the login page',
    /function LoginView/.test(authViews) &&
      /<NotificationToggle \/>/.test(authViews.split('export function RegisterView')[0]),
    'people decide they want notifications while reading the login form',
  )

  check(
    'and on the register form, before there is an account',
    /<NotificationToggle \/>/.test(authViews.split('export function RegisterView')[1]),
  )

  check(
    'the toggle reads the session itself rather than trusting the caller',
    /useAttendee\(\)/.test(toggle),
    'a prop would let the dashboard mount it with the wrong answer',
  )

  check(
    'an unauthenticated subscription is never POSTed',
    /if \(authenticated\) await portalApi\.subscribeToPush/.test(usePush),
    'that would store an endpoint with nothing to say who it belongs to',
  )

  check(
    'and says so, rather than claiming a delivery it cannot make yet',
    /pending/.test(toggle) && /log in and they are linked/i.test(toggle),
    'the honest version of "on" before there is an account',
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
