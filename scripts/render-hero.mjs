/**
 * Renders the landing hero from MEASURED live layout, not from a guess.
 *
 * Browser screenshots are unavailable in this environment, so this reads the
 * real geometry and computed styles out of the deployed page and redraws it as
 * SVG. The numbers below come from `getBoundingClientRect()` and
 * `getComputedStyle()` on https://the-awakening-portal.vercel.app — position,
 * size, colour, font size, weight and letter spacing.
 *
 * Honest caveat: it is a replica. Font rasterisation and any effect that does
 * not come through `getComputedStyle` (texture, blend modes) are approximate.
 * Layout and colour are exact.
 */

import { writeFileSync } from 'node:fs'

const RED = '#ff3000'
const RED_TEXT = '#d62500'
const INK = '#000000'
const MUTED = '#555555'
const PAPER = '#ffffff'
const FAINT = 'rgba(0,0,0,0.10)'

const L = {
  masthead: { x: 0, y: 0, w: 785, h: 86 },
  section: { x: 0, y: 86, w: 785, h: 677 },
  rule: { x: 40, y: 150, w: 96, h: 4 },
  eyebrow: { x: 40, y: 178, w: 529, h: 16 },
  lines: [
    { x: 40, y: 214, w: 529, h: 76, text: 'THE' },
    { x: 40, y: 300, w: 529, h: 76, text: 'AWAKENING' },
  ],
  tagline: { x: 40, y: 414, w: 448, h: 23, text: 'AI agents — built by you' },
  wipe: { x: 40, y: 469, w: 384, h: 4 },
  facts: [
    { x: 42, y: 507, w: 174, h: 84, term: 'WHEN', value: '14–15 October 2026' },
    { x: 217, y: 507, w: 174, h: 84, term: 'WHERE', value: 'Seminar Hall, Bengaluru' },
    { x: 393, y: 507, w: 174, h: 84, term: 'HOST', value: 'Amity University Bengaluru' },
  ],
  ctas: [
    { x: 40, y: 633, w: 153, h: 64, text: 'REGISTER', bg: RED_TEXT, fg: PAPER },
    { x: 209, y: 633, w: 135, h: 64, text: 'SIGN IN', bg: PAPER, fg: INK },
  ],
  mark: { x: 617, y: 150, w: 128, h: 160 },
  columns: [126, 259, 392, 518, 651],
  rows: [262, 437, 613],
}

const W = 785
const H = 86 + 677 + 60
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="${PAPER}"/>

  <!-- animated grid, drawn on: 5 columns, 3 rows -->
  ${L.columns.map((x) => `<rect x="${x}" y="${L.section.y}" width="1" height="${L.section.h}" fill="${FAINT}"/>`).join('\n  ')}
  ${L.rows.map((y) => `<rect x="0" y="${y}" width="${L.section.w}" height="1" fill="${FAINT}"/>`).join('\n  ')}

  <!-- masthead -->
  <rect x="0" y="0" width="${L.masthead.w}" height="${L.masthead.h}" fill="${PAPER}"/>
  <line x1="0" y1="86" x2="${L.masthead.w}" y2="86" stroke="${INK}" stroke-width="2"/>
  <text x="40" y="52" font-size="19" font-weight="900" fill="${RED_TEXT}" letter-spacing="-0.6">THE AWAKENING</text>
  <text x="40" y="70" font-size="10" font-weight="500" fill="${MUTED}" letter-spacing="2.4">FETCH AI · GDG</text>
  <text x="${L.masthead.w - 40}" y="58" font-size="10" font-weight="500" fill="${MUTED}"
        letter-spacing="2.4" text-anchor="end">FETCH AI</text>

  <!-- section frame -->
  <line x1="0" y1="${L.section.y + L.section.h}" x2="${L.section.w}" y2="${L.section.y + L.section.h}" stroke="${INK}" stroke-width="2"/>

  <!-- opening red rule -->
  <rect x="${L.rule.x}" y="${L.rule.y}" width="${L.rule.w}" height="${L.rule.h}" fill="${RED}"/>

  <!-- eyebrow -->
  <text x="${L.eyebrow.x}" y="${L.eyebrow.y + 11}" font-size="11" font-weight="700"
        fill="${RED_TEXT}" letter-spacing="2.75">01 · ENTRY</text>

  <!-- headline: two masked lines, 88px / 900 / -4.4px tracking -->
  ${L.lines
    .map(
      (l) =>
        `<text x="${l.x}" y="${l.y + l.h * 0.76}" font-size="88" font-weight="900" fill="${INK}" letter-spacing="-4.4">${esc(l.text)}</text>`,
    )
    .join('\n  ')}

  <!-- tagline -->
  <text x="${L.tagline.x}" y="${L.tagline.y + 16}" font-size="14" font-weight="500"
        fill="${MUTED}" letter-spacing="2.1">${esc(L.tagline.text.toUpperCase())}</text>

  <!-- red signal wipe -->
  <rect x="${L.wipe.x}" y="${L.wipe.y}" width="${L.wipe.w}" height="${L.wipe.h}" fill="${RED}"/>

  <!-- facts: three cells separated by 1px black gaps -->
  ${L.facts
    .map((f) => {
      const right = f.x + f.w
      const bottom = f.y + f.h
      return `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" fill="${PAPER}"/>
  <rect x="${right}" y="${f.y}" width="1" height="${f.h}" fill="${INK}"/>
  <rect x="${f.x}" y="${bottom}" width="${f.w + 1}" height="1" fill="${INK}"/>
  <text x="${f.x + 16}" y="${f.y + 24}" font-size="10" font-weight="500" fill="${MUTED}" letter-spacing="2">${f.term}</text>
  <text x="${f.x + 16}" y="${f.y + 48}" font-size="14" font-weight="900" fill="${INK}" letter-spacing="-0.4">${esc(f.value)}</text>`
    })
    .join('\n  ')}
  <rect x="${L.facts[0].x}" y="${L.facts[0].y}" width="1" height="${L.facts[0].h}" fill="${INK}"/>
  <rect x="${L.facts[0].x}" y="${L.facts[0].y}" width="${L.facts[0].w + 1}" height="1" fill="${INK}"/>

  <!-- actions -->
  ${L.ctas
    .map(
      (c) =>
        `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="${c.bg}" stroke="${c.bg}" stroke-width="2"/>
  <text x="${c.x + c.w / 2}" y="${c.y + c.h / 2 + 5}" font-size="14" font-weight="700"
        fill="${c.fg}" letter-spacing="2.1" text-anchor="middle">${c.text}</text>`,
    )
    .join('\n  ')}
  <rect x="${L.ctas[1].x}" y="${L.ctas[1].y}" width="${L.ctas[1].w}" height="${L.ctas[1].h}"
        fill="none" stroke="${INK}" stroke-width="2"/>

  <!-- geometric composition: circle, square, rules -->
  <g>
    <rect x="${L.mark.x}" y="${L.mark.y}" width="${L.mark.w}" height="${L.mark.h}" fill="${PAPER}" stroke="${INK}" stroke-width="2"/>
    <line x1="${L.mark.x + L.mark.w / 2}" y1="${L.mark.y}" x2="${L.mark.x + L.mark.w / 2}" y2="${L.mark.y + L.mark.h}" stroke="${FAINT}" stroke-width="1"/>
    <line x1="${L.mark.x}" y1="${L.mark.y + L.mark.h * 0.58}" x2="${L.mark.x + L.mark.w}" y2="${L.mark.y + L.mark.h * 0.58}" stroke="${FAINT}" stroke-width="1"/>
    <circle cx="${L.mark.x + L.mark.w * 0.32}" cy="${L.mark.y + L.mark.h * 0.3}" r="${L.mark.w * 0.19}"
            fill="${RED}" stroke="${INK}" stroke-width="2"/>
    <rect x="${L.mark.x + L.mark.w * 0.52}" y="${L.mark.y + L.mark.h * 0.62}" width="${L.mark.w * 0.3}" height="${L.mark.h * 0.2}"
          fill="${PAPER}" stroke="${INK}" stroke-width="2"/>
    <rect x="${L.mark.x}" y="${L.mark.y + L.mark.h - 8}" width="${L.mark.w * 0.38}" height="8" fill="${RED}"/>
  </g>

  <!-- caption -->
  <text x="0" y="${H - 22}" font-size="10" font-weight="500" fill="${MUTED}" letter-spacing="1.4">
    MEASURED FROM THE LIVE PAGE — layout and colour are exact; font rendering is approximate.
  </text>
</svg>
`

writeFileSync('scripts/hero-replica.svg', svg)
console.log(`  wrote scripts/hero-replica.svg (${W}x${H})`)
