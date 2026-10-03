#!/usr/bin/env node
/**
 * Static checks on the scan confirmation.
 *
 * These assert on the built source rather than on a live browser session,
 * because both defects are structural: state that is written but never read,
 * and focus that is restored on a path where it must not be. Both are invisible
 * to an API-level test — the request succeeds either way and the row is written
 * either way, which is exactly why they survived deployment.
 *
 *   node --experimental-strip-types scripts/test-scan-confirmation.mjs
 */

import { declaration, readCode, tally } from './_source.mjs'

const PROVIDER = 'src/auth/AdminProvider.tsx'
const VIEW = 'src/views/admin/AdminPortalView.tsx'
const CONTEXTS = 'src/auth/contexts.ts'

const providerCode = readCode(PROVIDER)
const viewCode = readCode(VIEW)
const contextsCode = readCode(CONTEXTS)

const { check, report } = tally()

console.log('\n  Scan confirmation\n')

/* -- 1. the confirmation is actually rendered ------------------------------- */

check(
  'the scan record is read by the view',
  /\blastScan\b/.test(viewCode),
  'AdminPortalView never mentions lastScan',
)
check(
  'the confirmation component exists',
  /function ScanConfirmation/.test(viewCode),
)
check(
  'the confirmation is mounted in the scan panel',
  /<ScanConfirmation[\s\S]{0,200}scan=\{lastScan\}/.test(viewCode),
  'ScanConfirmation is defined but never mounted',
)
check(
  'the attendee name is shown',
  /\{scan\.name\}/.test(viewCode),
)
check(
  'the SEN is shown',
  /\{scan\.sen\}/.test(viewCode),
)
check(
  'the admission method is shown',
  /scan\.method === 'qr'/.test(viewCode),
  'the qr/printed distinction is not surfaced to the operator',
)

/*
  The original defect: `setNotice(...)` fired on every successful scan and
  nothing in the tree read `notice`, so a scan confirmed itself silently. The
  state no longer exists, so any reintroduction of a write-only message slot is
  the regression to catch.
*/
check(
  'no write-only message state remains',
  !/\bsetNotice\b|\bclearNotice\b/.test(providerCode) &&
    !/\bnotice\b\s*[:=]/.test(contextsCode),
  'a notice slot is back without a reader',
)
check(
  'the provider no longer formats a success sentence',
  !/marked present/.test(providerCode),
  'the record should be stored, not a formatted string',
)

/* -- 2. success is not styled as failure ------------------------------------ */

/*
  Red is reserved for failure. A success in the accent colour makes a working
  gate look broken, and the two would be indistinguishable to an operator
  scanning quickly.
*/
const confirmation = declaration(viewCode, 'function ScanConfirmation')
check(
  'the confirmation was located for inspection',
  confirmation.length > 200,
  'could not slice out ScanConfirmation',
)
check(
  'the confirmation does not use the accent colour',
  confirmation.length > 200 && !/swiss-accent/.test(confirmation),
  'success is rendered in the failure colour',
)
check(
  'success is announced politely, not as an alert',
  /role="status"/.test(confirmation) && !/role="alert"/.test(confirmation),
)

/* -- 3. camera scans do not steal focus ------------------------------------- */

/*
  The original defect: `record()` ended with an unconditional
  `inputRef.current?.focus()`, so a camera scan focused the SEN field, which on
  a phone raised the on-screen keyboard over the camera preview. The operator
  lost the view they were scanning with and had to dismiss the keyboard before
  the next badge.
*/
const record = viewCode.slice(viewCode.indexOf('const record = useCallback'))
const recordBody = record.slice(0, record.indexOf('}, [onScan, scanning])'))

check(
  'record() takes an explicit focus decision',
  /async \(raw: string, restoreFocus: boolean\)/.test(viewCode),
  'record() still restores focus unconditionally',
)
check(
  'focus is returned conditionally, not always',
  /if \(restoreFocus\) inputRef\.current\?\.focus\(\)/.test(recordBody),
  'focus is restored on every path',
)
check(
  'the camera path passes false',
  /onDetect=\{\(text\) => void record\(text, false\)\}/.test(viewCode),
  'the camera still grabs focus for the SEN field',
)
check(
  'the typed path still returns focus',
  /await record\(value, true\)/.test(viewCode),
  'typing lost its next-entry convenience',
)
check(
  'the camera scan handler does not focus directly',
  !/onDetect[\s\S]{0,160}inputRef\.current\?\.focus\(\)/.test(viewCode),
  'focus is being taken inside the detector callback',
)

/* -- 4. a stale name is never left on screen -------------------------------- */

/*
  The confirmation persists until the next scan (it no longer auto-dismisses in
  3s, which is short enough to vanish before the name has been read back). So it
  must be cleared the moment a new scan starts, or the previous attendee's name
  sits on screen beside the next person.
*/
check(
  'a new scan clears the previous confirmation',
  /setScanning\(true\)[\s\S]{0,200}setLastScan\(null\)/.test(providerCode),
  'lastScan is never cleared, so a stale name persists',
)
check(
  'the confirmation is dismissible by hand',
  /onDismiss=\{onDismissScan\}/.test(viewCode) &&
    /type="button"[\s\S]{0,120}onClick=\{onDismiss\}/.test(confirmation),
)
check(
  'nothing auto-dismisses it any more',
  !/setTimeout\(clearLastScan/.test(viewCode),
  'the confirmation still times out before it can be read',
)

/* -- 5. success and failure are cleared independently ----------------------- */

check(
  'clearing an error does not clear the confirmation',
  /const clearError = useCallback\(\(\) => setError\(null\)/.test(providerCode) &&
    /const clearLastScan = useCallback\(\(\) => setLastScan\(null\)/.test(providerCode),
  'one action wipes both, so dismissing a failure erases the last success',
)

report()