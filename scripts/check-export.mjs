/**
 * Verifies the exact CSV bytes `downloadAttendanceCsv` produces.
 *
 * The export is client-side Blob work, which is awkward to assert on through a
 * browser harness. This imports the REAL module and stubs only the two browser
 * globals it touches, so the assertion is on shipping code rather than a copy
 * that could drift from it.
 *
 *   node scripts/check-export.mjs
 */

import { writeFileSync } from 'node:fs'
import { downloadAttendanceCsv } from '../src/lib/exportAttendance.ts'

/** Captures what the function tries to hand the browser. */
let captured = null

const realCreateObjectURL = URL.createObjectURL
URL.createObjectURL = (blob) => {
  captured = blob
  return 'blob:stub'
}
URL.revokeObjectURL = () => {}

globalThis.document = {
  createElement: () => ({
    href: '',
    download: '',
    click() {},
    remove() {},
    style: {},
  }),
  body: { append() {} },
}

/*
  Three records, deliberately MIXED across two days.

  The export takes the whole log plus the day it wants, so the only way to be
  sure day two really does exclude day one is to hand it a log that contains
  both. Records that all shared a day would let a filter that ignores the
  argument entirely still pass every assertion below.

  The SENs are synthetic and obviously so — `Z` and all zeros. They must never
  be mistaken for attendance on the live roster, and a real-looking number in a
  checked-in file is exactly how that mistake happens.
*/
const records = [
  { id: '1', sen: 'Z000000000001', attendeeId: 'a', at: '', day: 1, method: 'printed' },
  { id: '2', sen: 'Z000000000002', attendeeId: 'b', at: '', day: 2, method: 'qr' },
  { id: '3', sen: 'Z000000000003', attendeeId: 'c', at: '', day: 1, method: 'qr' },
]

downloadAttendanceCsv(records, 'The Awakening', 1)

if (captured === null) {
  console.error('  nothing was passed to URL.createObjectURL')
  process.exit(1)
}

const text = await captured.text()
// `Blob.text()` runs a UTF-8 decode that REMOVES a leading BOM, so the decoded
// string cannot tell us whether the BOM bytes are in the file. Read the raw
// buffer — that is what Excel actually receives.
const raw = new Uint8Array(await captured.arrayBuffer())

console.log('  escaped: ' + JSON.stringify(text))
console.log('  first 3 bytes: ' + Array.from(raw.slice(0, 3)).map((b) => b.toString(16).padStart(2, '0')).join(' '))
console.log('  visible:')
process.stdout.write(text.replace(/^﻿/, ''))

const lines = text.replace(/^﻿/, '').trimEnd().split('\r\n')

let failed = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('')

// Day one only. Day two's record must not appear — see the note above the data.
const dayOne = records.filter((r) => r.day === 1)
check(
  'one line per SEN for that day, no header',
  lines.length === dayOne.length,
  `got ${lines.length} lines, expected ${dayOne.length}`,
)
check('first line is a SEN, not a header', lines[0] === `"${dayOne[0].sen}"`, `got ${lines[0]}`)
check('no "SEN" header anywhere', !lines.includes('"SEN"'))
check(
  'values in scan order',
  lines.join('|') === dayOne.map((r) => `"${r.sen}"`).join('|'),
)
// The day-two SEN is present in the source log. Its absence from the file is the
// assertion that the day argument is honoured rather than ignored.
check(
  'other days excluded',
  !text.includes(records.find((r) => r.day === 2).sen),
)
// EF BB BF is the UTF-8 encoding of U+FEFF.
check(
  'UTF-8 BOM present for Excel',
  raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
  `got ${Array.from(raw.slice(0, 3)).map((b) => b.toString(16)).join(' ')}`,
)
check('CRLF line endings', text.includes('\r\n'))
check('no "gate" anywhere in the file', !/gate/i.test(text))

// Leave a copy on disk so it can be opened in Excel directly.
writeFileSync('scripts/export-sample.csv', raw)
console.log('\n  wrote scripts/export-sample.csv')

URL.createObjectURL = realCreateObjectURL
if (failed > 0) process.exitCode = 1
