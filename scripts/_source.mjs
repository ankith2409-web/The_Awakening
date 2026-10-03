/**
 * Source-reading helpers for the static test suites.
 *
 * These suites assert on the shipped source rather than on a live browser
 * session, because the defects they guard are structural: state that is written
 * but never read, focus restored on a path where it must not be, a control
 * hidden behind a breakpoint. None of those are visible to an API-level test,
 * because the request succeeds and the row is written either way.
 */

import { readFileSync } from 'node:fs'

/**
 * Strips comments before matching.
 *
 * The source files explain the defects they used to have, and those explanations
 * quote the old code verbatim — `setNotice(...)`, `marked present`. Matching raw
 * text therefore reports a fix as a regression, which is the worst possible
 * failure mode for a regression test: it cries wolf until someone deletes the
 * explanation and stops maintaining the file.
 *
 * Comments only. String literals are left intact, because assertions routinely
 * depend on values like `scan.method === 'qr'` — blanking literals to `''`
 * silently turns those into "not found".
 */
export function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/** Slices one top-level declaration out of comment-stripped source. */
export function declaration(source, header) {
  const start = source.indexOf(header)
  if (start === -1) return ''
  const next = source.indexOf('\nfunction ', start + header.length)
  return source.slice(start, next === -1 ? undefined : next)
}

/** Reads a source file and strips its comments in one step. */
export function readCode(path) {
  return code(readFileSync(path, 'utf8'))
}

/** Counts matches, for assertions about how many of something exist. */
export function count(source, pattern) {
  return (source.match(pattern) ?? []).length
}

/**
 * A tiny assertion tally.
 *
 * Each suite owns its own counters rather than sharing a runner, so a suite can
 * be run on its own and still print a self-contained summary.
 */
export function tally() {
  const state = { passed: 0, failed: 0 }
  return {
    check(label, ok, detail) {
      if (ok) {
        state.passed += 1
        console.log(`  ok    ${label}`)
      } else {
        state.failed += 1
        console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
      }
    },
    report() {
      console.log(`\n  ${state.passed} passed, ${state.failed} failed\n`)
      if (state.failed > 0) process.exitCode = 1
      return state
    },
  }
}