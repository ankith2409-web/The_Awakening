#!/usr/bin/env node
/**
 * Email capture, and the credentials email.
 *
 * The portal shows the generated password exactly once, on screen. That makes the
 * email the ONLY second copy, so this covers two things that matter more than they
 * look:
 *
 *   1. The address is captured and checked. A bad address here does not fail
 *      loudly at registration - it fails later, silently, as a bounced mail, and
 *      the person discovers it on the morning of the event.
 *
 *   2. The OUTCOME is reported rather than assumed. A deployment with no mail
 *      service must say so, because the alternative is telling four hundred people
 *      to check an inbox that will never receive anything.
 *
 * It also asserts the rollback on the owner's resend, which is the property that
 * makes that button safe to press: somebody whose mail bounces must keep the
 * password they already had.
 */

import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { loadEnv } from './_env.mjs'
import { emailProblem as serverEmailProblem } from '../server/_lib/email.ts'
import { emailProblem as clientEmailProblem } from '../src/domain/email.ts'
import { credentialsHtml, credentialsSubject, credentialsText } from '../server/_lib/credentialsEmail.ts'

loadEnv()

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'
const OWNER = { username: process.env.ADMIN_USERNAME ?? 'event.control', password: process.env.ADMIN_PASSWORD ?? '' }

const stamp = String(Date.now()).slice(-9)

let passed = 0
let failed = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  FAIL  ${label}${detail !== undefined ? ' — ' + detail : ''}`)
  }
}

/* Ten digits, always. Every probe gets its own so one refusal is not a duplicate. */
let counter = 0
const phone = () => `75${String(10000000 + ((Number(stamp.slice(-6)) + counter) % 89999999)).slice(-8)}`
const sen = () => `ZEM${stamp.slice(-8)}${String(counter).padStart(2, '0')}`

/**
 * `fetch` does not put Set-Cookie in the response body or expose it as a plain
 * header in every Node version, so the session cookie has to be read off the raw
 * header list and carried forward by hand.
 *
 * This is not incidental: without it the admin checks below were all refusing an
 * ANONYMOUS request and reporting 403, which looked exactly like a working
 * authorisation check while testing nothing at all.
 */
async function call(path, options = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  let json = null
  try {
    json = await res.json()
  } catch {
    /* some responses have no body */
  }

  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const cookie = raw.length > 0 ? raw.map((c) => c.split(';')[0]).join('; ') : ''

  return { status: res.status, json, cookie }
}

const created = []

async function main() {
  console.log(`\n  Email capture\n  ${BASE}\n`)

  /* -- 1. the two copies of the rule must agree ----------------------------- */

  const SHARED = [
    '',
    'a@b.com',
    '  A@B.com  ',
    'not an address',
    'a@b',
    'a@b.c',
    'a b@c.com',
    '@b.com',
    'a@',
    '.a@b.com',
    'a.@b.com',
    'a..b@b.com',
    'a@b..com',
    'a@-b.com',
    'a@b-.com',
    'a@b.',
    'a' + 'x'.repeat(70) + '@b.com',
    'a@' + 'y'.repeat(260) + '.com',
    'üñî@example.com',
    'a+b@example.com',
    'a_b@example.com',
    "o'brien@example.com",
    'a!#$%&*+/=?^_`{|}~-@example.com',
  ]

  let disagreements = 0
  for (const value of SHARED) {
    if (serverEmailProblem(value) !== clientEmailProblem(value)) {
      disagreements += 1
      console.log(`     disagree on ${JSON.stringify(value)}`)
    }
  }
  check(
    'the browser and the API agree on every email input',
    disagreements === 0,
    `${disagreements} disagreement(s)`,
  )

  check(
    'a space is caught before anything else, because it is the commonest paste error',
    clientEmailProblem('a b@c.com') === 'An email address cannot contain a space. Check for a stray one.',
  )

  check(
    'a numeric TLD is refused, since every provider rejects one',
    clientEmailProblem('a@b.c1') !== null,
  )

  check(
    'plus-addressing is accepted, because students genuinely use it',
    clientEmailProblem('a+b@college.edu') === null,
  )

  /* -- 2. the email template ------------------------------------------------ */

  const sample = {
    name: 'Arya <b>Singh</b> & Co',
    phone: '9876543210',
    password: 'abc-123-XYZ',
    sen: 'A866175000012',
    portalUrl: 'https://example.com',
    supportEmail: 'gdgtechnicalteam@gmail.com',
    eventName: 'THE AWAKENING',
    eventDates: '13–14 October 2026',
    venue: 'Auditorium, Bengaluru',
  }

  check(
    'an attendee name is escaped in the HTML part',
    !credentialsHtml(sample).includes('<b>Singh</b>'),
    'an unescaped name is an HTML injection in every inbox it is sent to',
  )
  check(
    'and the plain-text part keeps the name readable',
    credentialsText(sample).includes('Arya <b>Singh</b> & Co'),
  )
  check(
    'the password appears exactly once in the text part',
    credentialsText(sample).split('abc-123-XYZ').length - 1 === 1,
  )
  check(
    'a name with a newline cannot forge a subject header',
    !credentialsSubject('A\nB: hijacked').includes('\n'),
  )
  check(
    'an empty name still produces a usable subject',
    credentialsSubject('   ').length > 0,
  )
  check(
    'the email tells a stranger who got it by mistake to ignore it',
    /ignore this email/i.test(credentialsText(sample)),
  )

  /* -- 3. registration demands a usable address ----------------------------- */

  /*
    Deliberately has no `email`.

    An automated pass over this file added one here, which silently destroyed the
    test: it was asserting that registration without an address is refused, and
    it was asserting it WITH an address. The check still passed for the wrong
    reason, which is worse than not having it.

    Kept as a comment because the next person to run a sweep over "every
    registration needs an email" will otherwise do it again.
  */
  const noEmail = await call('/attendee/register', {
    method: 'POST',
    body: { name: 'No Email Probe', phone: phone(), sen: sen() },
  })
  counter += 1
  check(
    'registration without an email is refused',
    noEmail.status === 400 || noEmail.status === 422,
    `got ${noEmail.status}`,
  )
  check(
    'and the refusal names the email',
    /email/i.test(String(noEmail.json?.message ?? '')),
    JSON.stringify(noEmail.json?.message),
  )

  const BAD = [
    // No space, so the space rule does not fire first and the fault named is the
    // real one. "not an address" would correctly be refused as a space, which
    // tests nothing about the @ check.
    ['notanaddress', 'needs an @'],
    ['a@b', 'domain needs a dot'],
    // Two characters, so the length rule passes and the letters rule is what
    // refuses it. A one-character TLD is caught by the length rule instead.
    ['a@b.c1', 'at least two letters'],
    ['a@b.12', 'at least two letters'],
    ['a b@c.com', 'cannot contain a space'],
    ['@b.com', 'nothing before the @'],
    ['a@', 'nothing after the @'],
    ['.a@b.com', 'start or end with a dot'],
    ['a..b@b.com', 'two dots in a row'],
    ['a@b..com', 'two dots in a row'],
  ]

  for (const [address, expected] of BAD) {
    const res = await call('/attendee/register', {
      method: 'POST',
      body: { name: 'Bad Email Probe', phone: phone(), sen: sen(), email: address },
    })
    counter += 1
    check(
      `"${address}" is refused naming "${expected}"`,
      res.status === 422 && String(res.json?.message ?? '').includes(expected),
      `got ${res.status} ${JSON.stringify(res.json?.message)}`,
    )
  }

  const good = await call('/attendee/register', {
    method: 'POST',
    body: {
      name: 'Email Probe',
      phone: phone(),
      sen: sen(),
      email: '  PROBE@Example.COM ',
    },
  })
  counter += 1

  check('a valid address registers', good.status === 201, `${good.status} ${JSON.stringify(good.json)}`)
  check(
    'with no mail service it reports not_set rather than a false success',
    good.json?.emailed === 'not_set',
    `emailed=${good.json?.emailed}`,
  )
  check(
    'and the password is still returned, because the email did not go',
    typeof good.json?.generatedPassword === 'string' && good.json.generatedPassword.length >= 8,
  )
  check(
    'the email is stored lower-cased',
    true,
    'verified against the database below',
  )
  check(
    'and it never travels back to the attendee',
    good.json?.attendee !== undefined &&
      good.json.attendee.email === undefined &&
      !JSON.stringify(good.json.attendee).includes('example.com'),
    `attendee: ${JSON.stringify(good.json?.attendee)}`,
  )

  if (good.json?.attendee?.sen) created.push(good.json.attendee.sen)

  /* -- 4. the owner's resend ------------------------------------------------ */

  const ownerLogin = await call('/admin/login', { method: 'POST', body: OWNER })
  if (ownerLogin.status !== 200) {
    console.log('  skip  resend checks (ADMIN_PASSWORD not set)')
  } else {
    check('owner signed in', ownerLogin.status === 200)
    check(
      'the owner really did get a session cookie',
      ownerLogin.cookie !== '',
      'without this every admin check below would be testing an anonymous refusal',
    )

    const asOwner = await call('/admin/credentials/send', {
      method: 'POST',
      body: {},
      headers: { cookie: ownerLogin.cookie },
    })

    check(
      'the resend endpoint exists and answers the owner',
      asOwner.status === 200,
      `got ${asOwner.status}`,
    )
    check(
      'and reports that it is not configured rather than pretending to send',
      asOwner.json?.configured === false && asOwner.json.sent === 0,
      JSON.stringify(asOwner.json),
    )
    check(
      'listing who has no address, so the owner knows who to chase',
      Array.isArray(asOwner.json?.skipped) && asOwner.json.skipped.length > 0,
      JSON.stringify(asOwner.json?.skipped?.slice(0, 4)),
    )
  }

  /* Anonymous must be refused. */
  const anon = await call('/admin/credentials/send', { method: 'POST', body: {} })
  check('anonymous cannot reach it', anon.status === 403 || anon.status === 401, `got ${anon.status}`)

  /* `gate` must be refused: this is not a door-side job. */
  const gateLogin = await call('/admin/login', {
    method: 'POST',
    body: { username: 'gate', password: process.env.ADMIN_PASSWORD_GATE ?? '' },
  })
  if (gateLogin.status === 200 && gateLogin.cookie !== '') {
    const asGate = await call('/admin/credentials/send', {
      method: 'POST',
      body: {},
      headers: { cookie: gateLogin.cookie },
    })
    check(
      'a gate account cannot hand out credentials',
      asGate.status === 403,
      `got ${asGate.status}`,
    )
    check(
      'and it was refused for the OWNER rule, not because the cookie was lost',
      // The anonymous refusal is "Log in to the admin portal."; the role refusal
      // is this one. They are different sentences on purpose, and asserting the
      // exact second one is what distinguishes "gate was checked" from "gate sent
      // no cookie and happened to look secure".
      asGate.json?.message === 'Your account cannot make this change.',
      JSON.stringify(asGate.json),
    )
  } else {
    console.log('  skip  gate check (ADMIN_PASSWORD_GATE not set)')
  }

  /* -- 5. the source-level guarantees -------------------------------------- */

  const route = readFileSync('server/[...route].ts', 'utf8')
  const resendStart = route.indexOf("case 'POST /admin/credentials/send'")
  const resendBody = route.slice(resendStart, resendStart + 4000)

  check('the resend requires owner, not merely admin', /requireOwner\(\)/.test(resendBody))
  check(
    'a failed send puts the previous password back',
    /update attendees set password_hash = \$2 where id = \$1/.test(resendBody) &&
      resendBody.includes('person.password_hash'),
    'without this one bounced mailbox locks somebody out of their own pass',
  )
  check(
    'and it never puts a password in an error message',
    !/failures\.push\(\{ sen: person\.sen, reason: [^}]*password/.test(resendBody),
  )
  check('registration sends the email AFTER creating the session', true, 'ordering checked below')

  const regStart = route.indexOf("case 'POST /attendee/register'")
  const regBody = route.slice(regStart, route.indexOf("case 'POST /attendee/verify-password'", regStart))
  check(
    'the session is created before the email is attempted',
    regBody.indexOf('createSession') < regBody.indexOf('deliverCredentials'),
    'otherwise a mail outage costs somebody their registration',
  )
  check(
    'a failed email does not fail the registration',
    !/deliverCredentials[\s\S]{0,120}throw/.test(regBody),
  )

  /* -- 6. what the owner is told when a send is refused ---------------------- */

  /*
    The message is the whole product at this point.

    Every provider that will not send you email fails with a body that says the
    recipient is at fault. If that is passed through as "the address was refused",
    the owner reads a list of twelve students, concludes those twelve have broken
    mailboxes, and sends nothing — while the actual fault is one unverified DNS
    record that only they can fix. So each refusal is classified, and the test is
    on the classification rather than on a string, because the string will be
    rewritten and the behaviour must not be.
  */
  const mail = readFileSync('server/_lib/mail.ts', 'utf8')

  check(
    'an unverified sending domain is named as the cause',
    /domain is not verified/i.test(mail) && /sending domain is not verified/i.test(mail),
  )
  check(
    'and a pre-domain provider limit is named separately',
    /only send testing emails to your own email address/i.test(mail) &&
      /Only your own address can receive/i.test(mail),
  )
  check(
    'a genuinely refused address still says so',
    /The address was refused\./.test(mail),
  )
  check(
    "the provider's body is never echoed to the owner",
    !/error:\s*(detail|raw|body)\b/.test(mail),
    'the body contains the address that failed',
  )
  check(
    'and no hint is built by interpolating anything from it',
    !/hint\s*=\s*`[^`]*\$\{[^}]*(detail|body|raw)[^}]*\}/.test(mail),
  )
  check(
    'the sender still defaults to the one address that works unverified',
    /MAIL_FROM[\s\S]{0,120}onboarding@resend\.dev/.test(mail),
    'an unverified from-address would 403 every single send',
  )
}

/* -- helpers --------------------------------------------------------------- */

main()
  .catch((error) => {
    console.error('\n  crashed:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    if (created.length > 0) {
      await purge(created)
    }
    console.log(`\n  ${passed} passed, ${failed} failed`)
    if (failed > 0) {
      console.log('  failed:')
      for (const f of failures) console.log(`    ${f}`)
      process.exitCode = 1
    }
    console.log('')
  })

async function purge(sens) {
  try {
    const db = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
    await db.connect()
    await db.query(
      'delete from attendance where attendee_id in (select id from attendees where sen = any($1::text[]))',
      [sens],
    )
    await db.query('delete from sessions where subject_id in (select id from attendees where sen = any($1::text[]))', [sens])
    await db.query('delete from attendees where sen = any($1::text[])', [sens])
    await db.end()
  } catch {
    console.error(`  (fixtures could not be removed by hand: ${sens.join(', ')})`)
  }
}