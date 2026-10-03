/**
 * Phone normalisation and validation, checked against real inputs.
 *
 * Written as a file rather than `node -e` because a `$` inside a PowerShell
 * double-quoted string becomes an escaped literal, which silently turns the
 * regex end anchor into a required dollar sign — every number then "fails" and
 * the result looks like a validation bug rather than a test bug.
 *
 *   node scripts/test-phone.mjs
 */

import { isValidIndianMobile, normalisePhone, phoneProblem } from '../src/domain/phone.ts'

let passed = 0
let failed = 0

function check(label, actual, expected) {
  if (actual === expected) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}  got ${actual}, want ${expected}`)
  }
}

const accepted = [
  ['9876543210', 'plain ten digits'],
  ['09876543210', 'leading zero habit (098…)'],
  ['+91 98765 43210', 'with country code and spaces'],
  ['919876543210', 'country code, no plus'],
  ['+91-98765-43210', 'with separators'],
  ['  9876543210  ', 'surrounded by whitespace'],
  ['6 5 4 5 6 5 4 5 8 7', 'spaced out'],
]

const rejected = [
  ['0545654587', 'ten digits but starts with 0 — not a mobile prefix'],
  ['1234567890', 'ten digits starting 1'],
  ['545654587', 'nine digits, and starts with 5'],
  ['987654321', 'nine digits'],
  ['98765432101', 'eleven digits, no country code'],
  ['', 'empty'],
]

console.log('\n  Accepted\n')
for (const [input, label] of accepted) {
  const n = normalisePhone(input)
  check(`${label.padEnd(42)} ${JSON.stringify(input)} -> ${n}`, isValidIndianMobile(input), true)
}

console.log('\n  Rejected\n')
for (const [input, label] of rejected) {
  check(`${label.padEnd(42)} ${JSON.stringify(input)} -> ${normalisePhone(input)}`, isValidIndianMobile(input), false)
}

console.log('\n  Normalisation\n')
check('strips the 0 prefix', normalisePhone('09876543210'), '9876543210')
check('strips +91', normalisePhone('+91 98765 43210'), '9876543210')
check('strips 91', normalisePhone('919876543210'), '9876543210')
check('leaves a bare ten-digit number alone', normalisePhone('9876543210'), '9876543210')
check('leaves an invalid number alone', normalisePhone('0545654587'), '0545654587')

/*
  The specific reason matters more than the rejection itself.

  Someone typing `0545654587` has entered ten digits already. The old blanket
  "Enter a 10-digit mobile number" told them their digit count was wrong, which
  sent them hunting for a fault they do not have — the real problem is the
  leading zero. Each cause now gets its own message.
*/
console.log('\n  Error messages name the actual fault\n')
check(
  'ten digits starting with 0 → blamed on the 0, not the length',
  phoneProblem('0545654587'),
  'Mobile numbers do not start with 0. Remove it, or use your number with 91.',
)
check('wrong length → says how many were entered', phoneProblem('987654'), 'Enter a 10-digit mobile number. You entered 6.')
check('ten digits, wrong prefix → named', phoneProblem('1234567890'), 'Indian mobile numbers start with 6, 7, 8 or 9.')
check('empty → required', phoneProblem(''), 'Phone number is required.')
check('valid → no problem', phoneProblem('9876543210'), null)
check('0-prefixed but 11 digits → accepted', phoneProblem('09876543210'), null)

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
