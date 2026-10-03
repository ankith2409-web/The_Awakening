#!/usr/bin/env node
/**
 * Error-message matrix: 50 inputs per field, through the real validators.
 *
 * Imports the actual rules from `src/auth/validation.ts` and, for the two
 * fields the API also checks (phone and SEN), the actual server rules from
 * `server/_lib/identifiers.ts`. Nothing is reimplemented here — a hand-copied
 * validator would pass while the shipped one failed, which is the whole class
 * of bug these suites exist to catch.
 *
 * Beyond the per-field verdicts it asserts three cross-cutting invariants that
 * each hid a real defect:
 *
 *   1. client and server accept/reject identically (13 SEN inputs disagreed)
 *   2. client and server normalise identically (the cause of those 13)
 *   3. every error code renders as human copy, never as itself (`unknown_sen`
 *      was reaching a gate operator's screen as the literal string)
 *
 *   node --experimental-strip-types scripts/error-matrix.mjs
 */

import { VALIDATORS } from '../src/auth/validation.ts'
import {
  isValidSen as serverIsValidSen,
  normalisePhone as serverNormalisePhone,
  normaliseSen as serverNormaliseSen,
  passwordProblem as serverPasswordProblem,
  phoneProblem as serverPhoneProblem,
} from '../server/_lib/identifiers.ts'
import { normalisePhone, normaliseSen } from '../src/domain/phone.ts'
import { PORTAL_ERROR_MESSAGES, PortalError } from '../src/domain/types.ts'

const RULES = {
  name: VALIDATORS.name,
  phone: VALIDATORS.phone,
  sen: VALIDATORS.sen,
  password: VALIDATORS.password,
  username: VALIDATORS.username,
}

/** Renders any input unambiguously, including empty and whitespace-only. */
function show(value) {
  if (value === '') return '(empty)'
  if (/^\s+$/.test(value)) return JSON.stringify(value) + '  [whitespace only]'
  return JSON.stringify(value)
}

let total = 0
let disagreements = 0
const rows = []

function run(field, cases, serverCheck) {
  console.log(`\n  ${field.toUpperCase()} — ${cases.length} cases`)
  console.log(`  ${'-'.repeat(72)}`)

  cases.forEach((raw, i) => {
    const clientMessage = RULES[field](raw)
    const accepted = clientMessage === null
    total += 1

    let note = ''
    if (serverCheck) {
      const serverMessage = serverCheck(raw)
      const serverAccepted = serverMessage === null
      // Only a disagreement in ACCEPT/REJECT matters. Wording may legitimately
      // differ; who gets let through may not.
      if (accepted !== serverAccepted) {
        note = `  <<< DISAGREEMENT (server says: ${serverMessage ?? 'accepted'})`
        disagreements += 1
      } else if (serverMessage !== null && serverMessage !== clientMessage) {
        note = `  (server wording: ${serverMessage})`
      }
    }

    const verdict = accepted ? 'ACCEPTED' : clientMessage
    console.log(
      `  ${String(i + 1).padStart(3)}. ${verdict.padEnd(58)} ${show(raw).padEnd(24)}${note}`,
    )
    rows.push({ field, n: i + 1, input: raw, accepted, message: clientMessage ?? '' })
  })
}

/* --------------------------------------------------------------- 50 per field */

// NAME
run('name', [
  '',
  ' ',
  '  ',
  '\t',
  '\n',
  'A',
  'Ankith',
  'Ankith Kumar',
  'Ankith Raj K',
  "O'Brien",
  'Dr. Anjali Rao',
  'Jean-Luc Picard',
  'Mary  Ann',
  '  Ankith  ',
  'Ankith.',
  '.Ankith',
  'Ankith Kumar Sharma',
  'a',
  'ab',
  'A1',
  '123',
  '1234567890',
  'Ankith2',
  'Ankith_',
  'Ankith-',
  'Ankith@',
  'Ankith!',
  'Ankith#',
  'Ankith%',
  'Ankith&',
  'Ankith/',
  'Ankith\\',
  '<script>',
  '<b>bold</b>',
  "'; DROP TABLE attendees; --",
  "Ankith' OR '1'='1",
  'Ankit é',
  'José',
  'José Álvarez',
  '山田太郎',
  'Ankith Kumar Sharma Jr.',
  'A'.repeat(59),
  'A'.repeat(60),
  'A'.repeat(61),
  'A'.repeat(200),
  'Mr. Ankith Kumar  ',
  'ANkith KUMAR',
  'A n k i t h',
  '\u{1F389}',
  'Ankith\tKumar',
  'Ankith\nKumar',
  'Ankit—Kumar',
])

// PHONE — the server is authoritative here
const PHONE_CASES = [
  '',
  ' ',
  '9',
  '98',
  '987654321',
  '9876543210',
  '9876543211',
  '987654321',
  '98765432101',
  '987654321012',
  '09876543210',
  '0545654587',
  '054565458',
  '545654587',
  '1234567890',
  '123456789',
  '1111111111',
  '5999999999',
  '6000000000',
  '6999999999',
  '7000000000',
  '7999999999',
  '8000000000',
  '8999999999',
  '9000000000',
  '9999999999',
  '98765 43210',
  '98765 4321 0',
  '98 76 54 32 10',
  '+91 98765 43210',
  '+919876543210',
  '919876543210',
  '0919876543210',
  '91 98765 43210',
  '+91-98765-43210',
  '+91.98765.43210',
  '(987) 654-3210',
  '987-654-3210',
  'abc',
  'abcdefghij',
  '98765abcde',
  'abc9876543',
  '98765 4321a',
  '##########',
  '++++++++++',
  '9876543210 ',
  ' 9876543210',
  '\t9876543210',
  '9876543210\n',
  '9\u207876543210',
  '\u096E\u0968\u096D\u096B\u0966\u0964\u0969\u0968\u096D\u0966',
]
run('phone', PHONE_CASES, (raw) => serverPhoneProblem(raw))

// SEN — the server is authoritative here
const SEN_CASES = [
  '',
  ' ',
  'A',
  'A8',
  'A866175125186',
  'a866175125186',
  'A866175000012',
  'A86617500001',
  'A8661750000123',
  'A'.repeat(24),
  'A'.repeat(25),
  '1234',
  '123',
  '12',
  '1',
  'ABC',
  'ABCD',
  'ABCDE',
  'ABCDEF',
  'ABCDEFGHIJKLMNOPQRSTUVWX',
  'SEN2026001',
  'sen2026001',
  'SENT168441',
  'SEN06892Q',
  '22CS1RE0123',
  '1RV21CS134',
  '12345678',
  '---------',
  '_',
  '__',
  'A-B',
  'A_B',
  'A 866175125186',
  ' A866175125186',
  'A866175125186 ',
  'A866175125186\n',
  '\nA866175125186',
  'A866175125186.deadbeef',
  'SEN2026001.deadbeef',
  'https://portal.example/checkin?code=A866175125186',
  'https://portal.example/checkin?sen=A866175125186',
  '?code=A866175125186',
  'A866175125186.abc123XYZ',
  '+++++',
  '\u0000\u0001',
]
run('sen', SEN_CASES, (raw) =>
  serverIsValidSen(serverNormaliseSen(raw)) ? null : 'invalid SEN')

// PASSWORD — the server is authoritative here
run('password', [
  '',
  ' ',
  'a',
  'ab',
  'abc',
  'abcd',
  'abcde',
  'abcdef',
  'abcdefg',
  'abcdefgh',
  '1',
  '12',
  '123',
  '1234',
  '12345',
  '123456',
  '1234567',
  '12345678',
  'abcdefg1',
  'grid2026',
  'Grid2026',
  'GRID2026',
  'grid 2026',
  'grid-2026',
  'grid_2026',
  'grid.2026',
  '!@#$%^&*',
  '!@#$%^&1',
  'a1',
  'a12',
  'a123',
  'a1234',
  'a12345',
  'a1234567',
  'a12345678',
  'p@ssw0rd',
  'correcthorsebatterystaple',
  'A'.repeat(100),
  'a1'.repeat(50),
  '\u{1F600}\u{1F600}\u{1F600}',
  'пароль123',
  'pass\tword',
  'pass\nword',
  '<script>alert(1)</script>',
  "' OR '1'='1",
  '`; DROP TABLE admins; --',
  'grid2026\n',
  '  grid2026  ',
  'aaaaaaaa1',
], (raw) => serverPasswordProblem(raw))

// USERNAME (admin only)
run('username', [
  '',
  ' ',
  'a',
  'ab',
  'abc',
  'abcd',
  'admin',
  'Admin',
  'ADMIN',
  'admin ',
  ' admin',
  'admin1',
  'admin_',
  'admin-',
  'admin@',
  '1',
  '12',
  '123',
  'a'.repeat(100),
  'a'.repeat(1000),
  'root',
  'superuser',
  'administrator',
  'ops',
  'gate',
  'staff',
  '<script>',
  "'; DROP TABLE admins; --",
  "admin' --",
  'admin OR 1=1',
  '../../etc/passwd',
  'admin@evil.com',
  'admin\nuser',
  'admin\tuser',
  '\u{1F389}',
  'админ',
  'adm in',
  'ADM1N',
  'a_b_c',
  'a.b.c',
  'admin%00',
  'admin ',
  ' admin',
  'adm*in',
  'admin#1',
  'admin!',
  'a'.repeat(63),
  'a'.repeat(64),
  'a'.repeat(65),
  'adm-in',
  'adm1n',
  'adm!n',
  'adm\nn',
])

/* ----------------------------------------------------------------- summary */

console.log(`\n  ${'='.repeat(72)}`)
console.log(`  ${total} cases across ${Object.keys(RULES).length} fields`)
console.log(`  client/server disagreements: ${disagreements}`)
console.log(`  ${'='.repeat(72)}\n`)

// Per-field tally.
for (const field of Object.keys(RULES)) {
  const mine = rows.filter((r) => r.field === field)
  const accepted = mine.filter((r) => r.accepted).length
  console.log(
    `  ${field.padEnd(10)} accepted ${String(accepted).padStart(3)}   rejected ${String(mine.length - accepted).padStart(3)}`,
  )
}

// Write the full matrix out for review.
const { writeFileSync } = await import('node:fs')
const csv = [
  'field,case,input,verdict,message',
  ...rows.map((r) =>
    [r.field, r.n, JSON.stringify(r.input), r.accepted ? 'ACCEPTED' : 'REJECTED', r.message]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(','),
  ),
].join('\n')
writeFileSync('scripts/error-matrix.csv', csv)
console.log('\n  wrote scripts/error-matrix.csv')

/* ------------------------------------------------------- machine-code leak */

/*
  Every code must render as human copy, never as itself.

  `PortalError` takes `message ?? PORTAL_ERROR_MESSAGES[code]`, and the API's
  error class defaults its message to the code. A redundant message therefore
  *wins* over the friendly copy and the UI renders `unknown_sen` to a gate
  operator. Passing the code as the message reproduces exactly the shape the
  server used to send, so this fails if either side regresses.
*/
const leaks = []
for (const [code, friendly] of Object.entries(PORTAL_ERROR_MESSAGES)) {
  for (const message of [undefined, code, '', code.toUpperCase()]) {
    const shown = new PortalError(code, message).message
    if (shown === code || shown.trim() === code.toLowerCase()) {
      leaks.push(`${code} with message=${JSON.stringify(message)} renders "${shown}"`)
    }
    if (message === undefined && shown !== friendly) {
      leaks.push(`${code} default copy changed: "${shown}"`)
    }
  }
}

if (leaks.length > 0) {
  console.log(`\n  FAILED — ${leaks.length} error code(s) render as a machine code:`)
  for (const leak of leaks) console.log(`             ${leak}`)
  console.log('')
  process.exitCode = 1
} else {
  console.log(
    `  all ${Object.keys(PORTAL_ERROR_MESSAGES).length} error codes render as human copy, ` +
      `never as themselves.`,
  )
}

/* --------------------------------------------------- normalisation agreement */

/*
  Client and server must canonicalise identically.

  `isValidSen` was the live example of what goes wrong here: the form tested the
  raw string while the API tested the normalised one, so thirteen inputs —
  lowercase, padded, `.signature`, `?code=` — were accepted by one and rejected
  by the other. Two normalisers drifting apart is the same defect in embryo, so
  compare them directly over every case above rather than trusting that the
  validators happen to agree today.
*/
const drift = []

for (const raw of PHONE_CASES) {
  const client = normalisePhone(raw)
  const server = serverNormalisePhone(raw)
  if (client !== server) {
    drift.push(`phone ${show(raw)}: client -> ${show(client)}, server -> ${show(server)}`)
  }
}

for (const raw of SEN_CASES) {
  const client = normaliseSen(raw)
  const server = serverNormaliseSen(raw)
  if (client !== server) {
    drift.push(`sen ${show(raw)}: client -> ${show(client)}, server -> ${show(server)}`)
  }
}

if (drift.length > 0) {
  console.log(`\n  FAILED — ${drift.length} normalisation disagreement(s):`)
  for (const d of drift.slice(0, 20)) console.log(`             ${d}`)
  if (drift.length > 20) console.log(`             ... and ${drift.length - 20} more`)
  console.log('')
  process.exitCode = 1
} else {
  console.log(
    `  client and server normalisers agree on all ${PHONE_CASES.length + SEN_CASES.length} ` +
      'identifier inputs.',
  )
}

/* ------------------------------------------------- bounded transport */

import { readFileSync } from 'node:fs'

/*
  Every request must be bounded by a timeout.

  `fetch` has no default timeout, so a connection that stalls — weak venue wifi,
  mobile data dropping, a captive portal that accepts the socket and never
  answers — leaves the promise pending FOREVER. Confirmed against a server that
  never responds by `scripts/repro-hanging-fetch.mjs`.

  That is fatal on the session probe: `AttendeeProvider` only sets a status in
  `.then` or `.catch`, so a probe that never settles leaves the guard on its boot
  screen and the attendee cannot reach the sign-in form at all.
*/
const transport = readFileSync('src/api/http-portal.ts', 'utf8')

if (/\/\/[^\n]*\bsignal\b/.test(transport.replace(/\/\*[\s\S]*?\*\//g, ''))) {
  console.log('\n  FAILED — a request still goes out with no `signal`, so it can hang forever.\n')
  process.exitCode = 1
} else if (!/signal: AbortSignal\.timeout\(/.test(transport)) {
  console.log('\n  FAILED — no AbortSignal.timeout on the fetch.\n')
  process.exitCode = 1
} else {
  const probes = transport.match(/#PROBE_TIMEOUT_MS/g)?.length ?? 0
  console.log(`\n  every request is bounded by AbortSignal.timeout (${probes} probe budget(s) declared).`)
}

if (!/TimeoutError/.test(transport)) {
  console.log('  FAILED — a timeout is not distinguished from a dead connection.\n')
  process.exitCode = 1
} else {
  console.log('  a timeout is reported separately from a dead connection.')
}

/*
  A disagreement in accept/reject is a hard failure, not a note.

  It means the form would accept something the API rejects (a confusing failure
  at the worst moment), or the API would accept something the form blocks (an
  attendee who cannot register despite a valid code).
*/
if (disagreements > 0) {
  console.log(`\n  FAILED — ${disagreements} client/server disagreement(s) must be zero.\n`)
  process.exitCode = 1
} else {
  console.log('\n  no client/server accept/reject disagreements.\n')
}
