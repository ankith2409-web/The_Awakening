#!/usr/bin/env node
/**
 * Motion layer: the rules, enforced.
 *
 * Motion is easy to add and easy to add badly. These checks pin the constraints
 * that keep it fast and safe, because each one has a specific failure behind it:
 *
 *   - Animating anything but transform/opacity forces layout per frame, which
 *     drops frames on the mid-range phone an attendee holds on venue wifi.
 *   - The scan panel is the gate. Motion there competes with the one
 *     interaction that must be fast and reliable.
 *   - Uncapped stagger delays turn a long list into a wait. The attendance log
 *     can hold 500 rows.
 *   - `prefers-reduced-motion` must actually suppress the delay, not just the
 *     duration — otherwise a reduced-motion visitor still sits through the
 *     accumulated wait before anything appears.
 *
 *   node --experimental-strip-types scripts/test-motion.mjs
 */

import { readCode, tally } from './_source.mjs'

const CSS = 'src/styles/index.css'
const APP = 'src/App.tsx'
const ADMIN = 'src/views/admin/AdminPortalView.tsx'
const PANEL = 'src/components/EventStatusPanel.tsx'
const MOTION = 'src/lib/motion.ts'
const SKELETON = 'src/components/Skeleton.tsx'

const css = readCode(CSS)
const app = readCode(APP)
const admin = readCode(ADMIN)
const panel = readCode(PANEL)
const motion = readCode(MOTION)
const skeleton = readCode(SKELETON)

const { check, report } = tally()

console.log('\n  Motion layer\n')

/* -- 1. only transform and opacity ------------------------------------------ */

/*
  The strongest rule in the file, and the easiest to break by accident — someone
  adding `margin-top` to a `from` block gets a perfectly smooth animation that
  drops frames on a budget phone.

  Checked by reading every `@keyframes motion-*` body and rejecting the layout
  properties. `background-position` is allowed because the loading shimmer moves
  a gradient, not the box.
*/
const LAYOUT_PROPS = [
  'width',
  'height',
  'top',
  'right',
  'bottom',
  'left',
  'margin',
  'padding',
  'font-size',
  'border-width',
  'inset',
  'flex',
  'gap',
]

const keyframeBlocks = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)]
check('keyframes were found to check', keyframeBlocks.length > 0)

const offenders = []
for (const [name, body] of keyframeBlocks) {
  if (!name.startsWith('motion-')) continue
  for (const prop of LAYOUT_PROPS) {
    if (new RegExp(`(^|[;{\\s])${prop}\\s*:`, 'm').test(body)) {
      offenders.push(`${name} animates \`${prop}\``)
    }
  }
}
check(
  'no motion keyframe animates a layout property',
  offenders.length === 0,
  offenders.join('; '),
)

/* -- 2. durations stay short ------------------------------------------------ */

/*
  Motion slower than ~400ms on a transition stops reading as responsive and
  starts reading as lag. The tokens are the single place a duration is chosen,
  so checking them covers every animation that uses one.
*/
for (const [label, pattern] of [
  ['fast', /--motion-dur-fast:\s*(\d+)ms/],
  ['standard', /--motion-dur:\s*(\d+)ms/],
  ['slow', /--motion-dur-slow:\s*(\d+)ms/],
]) {
  const m = css.match(pattern)
  const value = m ? Number(m[1]) : NaN
  check(
    `the ${label} duration is set and under 400ms`,
    Number.isFinite(value) && value > 0 && value < 400,
    `${label} = ${m ? m[1] : 'unset'}ms`,
  )
}

/* -- 3. the gate stays still ------------------------------------------------- */

/*
  The one exclusion the organiser asked for. The scan panel is a volunteer
  standing at a door with a phone and a camera preview; a fade there reads as
  lag. Tabs, attendance and teams are fine — the scan panel is not.

  Matched on the structure rather than on the state variable's name. An earlier
  version grepped for `tab === 'scan'` and reported a regression when that
  variable was renamed to `activeTab` for role gating — the branch was still
  there, still correct, and still doing its job.
*/
const tabpanelClass = admin.match(/className=\{\s*\n?\s*\w*[Tt]ab === 'scan'[\s\S]{0,220}?\}/)
check(
  'the scan tab panel is explicitly excluded from motion',
  tabpanelClass !== null && /=== 'scan'/.test(tabpanelClass[0]) &&
    /'motion-tab-panel/.test(tabpanelClass[0]),
  'the scan panel no longer has its own no-motion branch',
)

const scanPanel = admin.slice(
  admin.indexOf('function ScanPanel'),
  admin.indexOf('function ScanConfirmation'),
)
check(
  'ScanPanel itself carries no motion class',
  !/motion-(rise|fade|stagger|tab-panel|scale-in)/.test(scanPanel),
  'motion leaked into the scan panel',
)

/* -- 4. stagger is capped --------------------------------------------------- */

/*
  An uncapped 45ms step over 500 attendance rows is a 22-second wait. The cap
  lives in one module so it cannot be forgotten at a call site.
*/
check(
  'the stagger cap exists',
  /STAGGER_CAP\s*=\s*\d+/.test(motion),
  'no cap — a long list would animate for tens of seconds',
)
const cap = Number((motion.match(/STAGGER_CAP\s*=\s*(\d+)/) ?? [])[1])
check(
  'the cap is small enough to stay invisible',
  Number.isFinite(cap) && cap > 0 && cap <= 12,
  `cap = ${cap}`,
)
check(
  'the stagger helper clamps its index',
  /Math\.min\(\s*index\s*,\s*STAGGER_CAP\s*\)/.test(motion),
  'the helper does not clamp, so the cap is documented but not applied',
)
check(
  'the CSS reads --i rather than hardcoding a delay',
  /--motion-stagger[\s\S]{0,400}var\(--i/.test(css) ||
    /animation-delay: calc\(var\(--i/.test(css),
)

/* -- 5. reduced motion is honoured, including the delay --------------------- */

/*
  The blanket rule collapses `animation-duration`, which is most of it. But
  `animation-delay` is a SEPARATE property and survives untouched — so without
  an explicit override a reduced-motion visitor still waits out the full
  accumulated stagger before anything appears, which is the precise opposite of
  what they asked for.
*/
check(
  'the blanket reduced-motion rule still exists',
  /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}animation-duration: 0\.01ms/.test(css),
)
check(
  'the stagger delay is explicitly zeroed for reduced motion',
  /prefers-reduced-motion: reduce\)\s*\{[\s\S]{0,400}\.motion-stagger[\s\S]{0,200}animation-delay:\s*0ms/.test(css),
  'a reduced-motion visitor still waits out the accumulated stagger',
)
check(
  'the skeleton loop is stopped for reduced motion',
  /prefers-reduced-motion: reduce\)[\s\S]{0,600}\.motion-skeleton[\s\S]{0,200}animation:\s*none/.test(css),
)

/* -- 6. motion carries meaning ---------------------------------------------- */

for (const [label, source, pattern] of [
  ['route change', app, /motion-fade/],
  ['admin tab swap', admin, /motion-tab-panel/],
  ['the attendance log rows', admin, /motion-stagger/],
  ['the dashboard programme rows', panel, /motion-stagger/],
  ['the loading placeholder', skeleton, /motion-skeleton/],
]) {
  check(`${label} animates`, pattern.test(source))
}

/*
  The only looping animation IN THE MOTION LAYER is the skeleton shimmer. A loop
  anywhere else in it is a permanent battery tax on someone holding the page open.

  Scoped to `motion-*` on purpose. The glitch mark (`gdg-*`) loops too, and has
  since before this layer existed: it is the design system's one documented
  decorative exception and it carries its own reduced-motion handling. Folding it
  in here would mean either deleting the brand mark or weakening the assertion
  until it caught nothing.
*/
const allLoops = [...css.matchAll(/animation:\s*([^;]*\binfinite\b[^;]*)/g)]
  .map((m) => m[1].trim())

const shimmerLoops = allLoops.filter((rule) => rule.startsWith('motion-shimmer'))
const strayLoops = allLoops.filter(
  (rule) => !rule.startsWith('motion-shimmer') && !rule.startsWith('gdg-'),
)

check(
  'the skeleton shimmer is the only motion-layer loop',
  shimmerLoops.length === 1,
  `found ${shimmerLoops.length} shimmer rules, expected exactly 1`,
)
check(
  'nothing outside the glitch mark loops',
  strayLoops.length === 0,
  `stray loops: ${strayLoops.join(' | ')}`,
)
check(
  'the glitch mark keeps its reduced-motion handling',
  /gdg-glitch-cycle[\s\S]{0,300}animation: none/.test(css),
  'the looping brand mark no longer has a reduced-motion escape',
)

report()
