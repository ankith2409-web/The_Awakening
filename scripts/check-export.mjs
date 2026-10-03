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

const records = [
  { id: '1', sen: 'A866175125186', attendeeId: 'a', at: '', gate: 'Gate A', method: 'printed' },
  { id: '2', sen: 'B866175125999', attendeeId: 'b', at: '', gate: 'Gate A', method: 'qr' },
  { id: '3', sen: 'A866175125187', attendeeId: 'c', at: '', gate: 'Gate A', method: 'qr' },
]

downloadAttendanceCsv(records, 'The Awakening')

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
check('one line per SEN, no header', lines.length === records.length, `got ${lines.length} lines`)
check('first line is a SEN, not a header', lines[0] === '"A866175125186"', `got ${lines[0]}`)
check('no "SEN" header anywhere', !lines.includes('"SEN"'))
check('values in scan order', lines.join('|') === records.map((r) => `"${r.sen}"`).join('|'))
// EF BB BF is the UTF-8 encoding of U+FEFF.
check(
  'UTF-8 BOM present for Excel',
  raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
  `got ${Array.from(raw.slice(0, 3)).map((b) => b.toString(16)).join(' ')}`,
)
check('CRLF line endings', text.includes('\r\n'))

// Leave a copy on disk so it can be opened in Excel directly.
writeFileSync('scripts/export-sample.csv', raw)
console.log('\n  wrote scripts/export-sample.csv')

URL.createObjectURL = realCreateObjectURL
if (failed > 0) process.exitCode = 1
