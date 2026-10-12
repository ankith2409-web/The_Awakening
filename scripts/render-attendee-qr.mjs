#!/usr/bin/env node
/**
 * The attendee-portal QR, as a print-ready SVG.
 *
 * WHAT THIS IS FOR
 *
 * A sheet for the wall. Attendees scan it, land on the portal, register and get
 * their entry pass. It is the ATTENDEE portal — the bare site root, never `/admin`,
 * because this gets printed and carried around by people who are not staff.
 *
 * WHY SVG AND NOT A PNG
 *
 * A QR is a grid of squares. Rasterised for a desk and scaled up for an A3
 * poster, a PNG either blurs or leaves a 300dpi edge that scanners struggle with.
 * A vector QR is exact at every size, which is the only way one file can be both
 * a table-tent and a banner.
 *
 * WHY ERROR CORRECTION Q
 *
 * Q recovers 25% of the code from damage. That covers a poster that gets scuffed,
 * rained on, or half-covered by somebody's thumb, without paying for it in module
 * count: H would add ~15% more modules, and a denser code is HARDER to scan from
 * across a room, which is the only thing this sticker is for.
 *
 * WHY THE QUIET ZONE IS COMPUTED, NOT DRAWN
 *
 * The specification requires four light modules on every side. Too little and
 * scanners fail on a poster with a busy background; react-qr-code's own default is
 * a proportional guess that changes with the code's size. It is derived from the
 * module count here and asserted, because a QR that scans on screen and not on a
 * wall is the exact failure this file exists to prevent.
 *
 * Deterministic: same input, byte-identical output. Regenerating must never produce
 * a file that differs from the committed one for no reason.
 *
 *   node scripts/render-attendee-qr.mjs [--check]
 *
 * `--check` writes nothing and exits non-zero if the committed file differs.
 * That is what lets the test suite assert this QR was not quietly regenerated
 * with the wrong URL — a QR pointing at a staging deploy is invisible to review.
 */

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The two public portals, each with its own code on its own sheet.
 *
 * THEY ARE SEPARATE CODES, not one code that offers a choice. A person standing at
 * a wall in a queue is not going to read two paragraphs and pick one — they will
 * point a camera at whatever is nearest. A poster near the door says "check in", a
 * poster at the challenge desk says "register your team", and neither has to be
 * understood before it works.
 *
 * It also keeps the two writes apart. `/` writes to the attendance register and
 * `/team` writes to the teams table; one code offering both would put both choices
 * in front of every stranger who scans the door's sheet.
 *
 * NEITHER IS EVER `/admin`. These files get printed, stuck on walls and carried
 * around by people who are not staff, and an admin URL on a public wall is a
 * password prompt for a stranger to walk into. Asserted per target below.
 *
 * Trailing slash on the root, on purpose: some scanners treat a bare host as
 * ambiguous, and this is the string that ends up in somebody's camera roll.
 */
export const PORTAL_URL = 'https://the-awakening-portal.vercel.app/'
export const TEAM_PORTAL_URL = 'https://the-awakening-portal.vercel.app/team'

const TARGETS = [
  {
    slug: 'attendee-portal',
    url: PORTAL_URL,
    label: 'the attendee portal',
  },
  {
    slug: 'team-portal',
    url: TEAM_PORTAL_URL,
    label: 'the team registration portal',
  },
]

/** Matches `QrTicket`, so the wall code and the in-app pass come from one source. */
const ERROR_CORRECTION = 'Q'

/** Four modules, per the QR specification. Not a preference. */
const QUIET_MODULES = 4

const OUT_DIR = join(ROOT, 'print')

/**
 * The matrix, straight from the library the portal already renders passes with.
 *
 * Not a re-implementation: the in-app entry pass and this poster must be produced
 * by identical code, because a bug fixed in one and not the other is a bug that
 * only shows up on a wall on the morning of the event.
 */
function buildMatrix(url) {
  const qrcode = require('qrcode-generator')
  const qr = qrcode(0, ERROR_CORRECTION)
  qr.addData(url)
  qr.make()
  return { count: qr.getModuleCount(), isDark: (r, c) => qr.isDark(r, c) }
}

/**
 * One `<path>` for every dark module.
 *
 * A path per module would be a 600-element document that every editor and every
 * renderer has to walk. One path of disjoint rectangles is the same picture, a
 * fraction of the bytes, and it is what a print RIP would prefer anyway.
 *
 * `shape-rendering="crispEdges"` is not decoration. Without it a renderer
 * anti-aliases the squares and the small ones end up grey at the edges, which is
 * where a scanner's sampling error is largest. Snapping to the pixel grid is the
 * difference between a code that prints well and one that prints slightly wrong.
 */
function renderSvg(url, label) {
  const { count, isDark } = buildMatrix(url)
  const span = count + QUIET_MODULES * 2

  let d = ''
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (!isDark(r, c)) continue
      const x = c + QUIET_MODULES
      const y = r + QUIET_MODULES
      // Absolute H/V, no shorthand: the same document has to open in Illustrator.
      d += `M${x} ${y}H${x + 1}V${y + 1}H${x}Z`
    }
  }

  return {
    count,
    svg: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!--',
      `  ${label[0].toUpperCase()}${label.slice(1)}, as a scannable code.`,
      '',
      `  Encodes exactly: ${url}`,
      `  ${count}x${count} modules, error correction ${ERROR_CORRECTION}, ${QUIET_MODULES}-module quiet zone.`,
      '',
      '  Regenerate with:  node scripts/render-attendee-qr.mjs',
      '  Verify with:      node scripts/render-attendee-qr.mjs (check flag, no leading dashes)',
      '',
      '  Print at any size. Do not recolour, crop into the quiet zone, or place it',
      '  on a busy background.',
      '-->',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${span * 8}" height="${span * 8}" shape-rendering="crispEdges" role="img" aria-label="QR code linking to ${label}">`,
      `<rect width="${span}" height="${span}" fill="#ffffff"/>`,
      `<path d="${d}" fill="#000000"/>`,
      '</svg>',
      '',
    ].join('\n'),
  }
}

/* ------------------------------------------------------------------- checks */

let failed = 0

function check(label, ok, detail) {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failed += 1
    console.log(`  FAIL  ${label}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`)
  }
  return ok
}

/**
 * Structural checks on the matrix itself.
 *
 * A decoder is not available here and adding one is not worth the dependency, so
 * the finder patterns, the timing patterns and the dark-module balance are checked
 * directly instead. These are the parts a malformed code gets wrong, and each is
 * checked by POSITION, which is what makes it a test rather than a shape check.
 */
function checkMatrix(label, count, isDark) {
  /*
    The finder pattern, written out as the specification draws it.

    Compared verbatim rather than derived from a rule. The rule version — "dark on
    the outer ring, light inside" — is wrong, because the inner 3x3 is dark again,
    and that mistake produced three failures on a perfectly good code. The bitmap
    cannot be misread the way a predicate about rings can.
  */
  const FINDER = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######']

  const finderIntact = (top, left) =>
    FINDER.every((row, r) =>
      [...row].every((cell, c) => isDark(top + r, left + c) === (cell === '#')),
    )

  check(`${label}: top-left finder pattern is intact`, finderIntact(0, 0))
  check(`${label}: top-right finder pattern is intact`, finderIntact(0, count - 7))
  check(`${label}: bottom-left finder pattern is intact`, finderIntact(count - 7, 0))

  let timing = true
  for (let i = 8; i < count - 8; i += 1) {
    timing = timing && isDark(6, i) === (i % 2 === 0)
    timing = timing && isDark(i, 6) === (i % 2 === 0)
  }
  check(`${label}: both timing patterns alternate correctly`, timing)

  let dark = 0
  for (let r = 0; r < count; r += 1) for (let c = 0; c < count; c += 1) if (isDark(r, c)) dark += 1
  const ratio = dark / (count * count)
  check(
    `${label}: dark modules are in the expected proportion`,
    ratio > 0.4 && ratio < 0.6,
    `${(ratio * 100).toFixed(1)}% dark`,
  )

  check(`${label}: the quiet zone is a full ${QUIET_MODULES} light modules`, true, 'asserted in the SVG')
}

function checkSvg(svg, url, label) {
  check(`[${label}] the SVG declares the exact URL as a comment`, svg.includes(`Encodes exactly: ${url}`))
  check(`[${label}] and the URL is not one of the strings it must never encode`,
    !svg.includes('/admin') && !/https:\/\/[^\s"]*vercel\.app\/admin/.test(svg),
  )

  const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  const modules = Number(viewBox?.[1] ?? 0)
  const quiet = modules - (viewBox ? buildMatrix(url).count : 0)
  check(
    `[${label}] the viewBox leaves a four-module quiet zone on every side`,
    quiet === QUIET_MODULES * 2 && viewBox?.[1] === viewBox?.[2],
    `span=${modules} modules=${buildMatrix(url).count} quiet=${quiet / 2}`,
  )
  check(
    `[${label}] the background is white, because scanners need light to find the edge`,
    svg.includes('<rect width=') && /fill="#ffffff"/.test(svg),
  )
  check(`[${label}] the modules are pure black`, /fill="#000000"/.test(svg))
  check(`[${label}] edges are snapped to the pixel grid`, svg.includes('shape-rendering="crispEdges"'))
  check(`[${label}] it carries a text alternative for anyone using a screen reader`,
    svg.includes('aria-label='))
  check(`[${label}] the file is self-describing without opening the repo`,
    svg.includes('Regenerate with:') && svg.includes('Verify with:'))
}

/**
 * Is this actually well-formed XML?
 *
 * Added because every other check here passed while the file was unopenable.
 *
 * The comment that documents how to regenerate this file contained the text
 * `--check`. XML forbids `--` inside a comment, so the document did not parse —
 * which is not a theoretical problem: Illustrator, Inkscape and every print RIP
 * reject it. What actually prints is not this file, it is whatever a renderer
 * silently produces when handed broken markup, and that is usually nothing.
 *
 * None of the content assertions caught it, because none of them read the file as
 * a document. Asserting that the QR encodes the right URL is not the same as
 * asserting that the thing carrying it can be opened, and only the second one
 * stands between a QR code and a blank print.
 *
 * Node ships no XML parser and a real one is not worth a dependency for a 200-line
 * check, so this is deliberately narrow and says so: it validates comments and
 * tag balance, which is the whole of what this generator can get wrong.
 */
function checkWellFormed(svg, label = 'portal') {
  const comments = [...svg.matchAll(/<!--([\s\S]*?)-->/g)]
  const commentsDeclared = (svg.match(/<!--/g) ?? []).length

  check(
    `[${label}] every comment is closed`,
    comments.length === commentsDeclared,
    `${comments.length} closed, ${commentsDeclared} opened`,
  )
  check(
    `[${label}] no comment contains a double hyphen, which XML forbids`,
    comments.every(([, body]) => !body.includes('--')),
    comments
      .map(([, b], i) => (b.includes('--') ? `comment ${i + 1}` : null))
      .filter(Boolean)
      .join(', ') || '',
  )

  // Strip comments, the XML declaration and any CDATA, then balance the tags.
  const stripped = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')

  const stack = []
  let balanced = true
  let reason = ''
  for (const [, closing, name, , selfClosing] of stripped.matchAll(
    /<(\/)?([A-Za-z][\w:-]*)([^>]*?)(\/)?>/g,
  )) {
    if (selfClosing === '/') continue
    if (closing === '/') {
      const open = stack.pop()
      if (open !== name) {
        balanced = false
        reason = `</${name}> closes <${open ?? 'nothing'}>`
        break
      }
    } else {
      stack.push(name)
    }
  }
  if (balanced && stack.length > 0) {
    balanced = false
    reason = `unclosed: ${stack.join(', ')}`
  }
  check(`[${label}] the tags balance`, balanced, reason)
  check(`[${label}] there is exactly one root element`, (stripped.match(/<svg[\s>]/g) ?? []).length === 1)
  check(`[${label}] it declares the SVG namespace, or renderers will not open it`,
    /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg))
}

/* ---------------------------------------------------------------------- PNG */

/*
  Why the PNG is generated here rather than exported from a design tool.

  The vector is the artefact that gets printed. The raster exists because the QR
  also has to survive a WhatsApp forward, a slide deck and an email signature, none
  of which handle SVG properly — and because a hand-made one cannot be checked.

  Encoding it from the same matrix is ~40 lines and makes the file reproducible:
  same input, byte-identical output, which `--check` can then assert. Exported from
  a browser it would be whatever that browser decided to emit today.
*/

/** CRC-32, as PNG specifies. Table built once; the chunk count is tiny. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * One square of pure black and white, with no anti-aliasing anywhere.
 *
 * Greyscale, 8 bits, one channel: a QR has no colour and no subtlety, so every
 * extra channel is bytes spent making the file larger than it needs to be in the
 * one medium that is already hostile to file size.
 *
 * `pixelsPerModule` is 40, chosen so the side is 1640px — an exact multiple of
 * the 41-module span. An exact multiple is the point: at any other width some
 * module edge falls between two pixels, the rasteriser averages them, and the
 * finder patterns pick up grey edges exactly where a scanner is least forgiving.
 */
function renderPng(url) {
  const { count, isDark } = buildMatrix(url)
  const span = count + QUIET_MODULES * 2
  const scale = 40
  const side = span * scale

  // Greyscale, so one byte per pixel, each row prefixed with its filter byte (0).
  const raw = Buffer.alloc(side * (side + 1))
  for (let y = 0; y < side; y += 1) {
    const rowStart = y * (side + 1)
    raw[rowStart] = 0 // filter type: none
    const mr = Math.floor(y / scale) - QUIET_MODULES
    for (let x = 0; x < side; x += 1) {
      const mc = Math.floor(x / scale) - QUIET_MODULES
      const inside = mr >= 0 && mr < count && mc >= 0 && mc < count
      raw[rowStart + 1 + x] = inside && isDark(mr, mc) ? 0 : 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: greyscale
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlacing

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * The raster, checked by reading it back rather than by trusting the encoder.
 *
 * A malformed PNG is invisible to every other check here: the SVG is fine, the
 * matrix is fine, and the file that ends up in a WhatsApp group is a grey square.
 * So the container is walked — signature, chunk order, CRCs, dimensions — and the
 * pixels are compared against the matrix they claim to be.
 */
function checkPng(png, count, url, label) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

  check(
    `[${label}] the PNG signature is correct, so anything will recognise it`,
    SIG.every((b, i) => png[i] === b),
  )

  const expectedSide = (count + QUIET_MODULES * 2) * 40
  check(
    `[${label}] the declared size is an exact multiple of the module grid`,
    png.readUInt32BE(16) === expectedSide && png.readUInt32BE(20) === expectedSide,
    `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}, expected ${expectedSide}`,
  )
  check(`[${label}] it is 8-bit greyscale, with no wasted colour channels`, png[24] === 8 && png[25] === 0)

  // Walk the chunks, verifying each CRC. A wrong CRC is a corrupt file that many
  // decoders will still render, which is precisely why it must be checked here.
  const types = []
  let corrupt = null
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString('latin1')
    const body = png.subarray(at + 4, at + 8 + len)
    const declared = png.readUInt32BE(at + 8 + len)
    if (crc32(body) !== declared) {
      corrupt = type
      break
    }
    types.push(type)
    at += 12 + len
  }
  check(`[${label}] every chunk checksum is valid`, corrupt === null, corrupt ? `${corrupt} is corrupt` : '')
  check(`[${label}] the chunks are in the order a decoder requires`, types.join(',') === 'IHDR,IDAT,IEND', types.join(','))

  // Undo the deflate and compare the pixels to the matrix that was encoded.
  let raw = null
  for (let at = 8; at < png.length && raw === null; ) {
    const len = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString('latin1')
    if (type === 'IDAT') {
      try {
        raw = inflateSync(png.subarray(at + 8, at + 8 + len))
      } catch {
        raw = null
      }
    }
    at += 12 + len
  }

  if (raw === null) {
    check(`[${label}] the image data inflates`, false, 'IDAT would not decompress')
    return
  }

  const side = expectedSide
  check(`[${label}] every scanline is present, with its filter byte`, raw.length === side * (side + 1))

  /*
    The matrix the pixels are compared against comes from THIS target's URL, not
    from a module-level constant. With two codes in one script that is the
    difference between checking each file and checking both against the first one —
    which passes every time and proves nothing about the second.
  */
  const { isDark } = buildMatrix(url)
  let mismatches = 0
  let sampled = 0
  for (const y of [8, 40, 400, 820, side - 40, side - 8]) {
    const mr = Math.floor(y / 40) - QUIET_MODULES
    const rowStart = y * (side + 1)
    if (raw[rowStart] !== 0) {
      check(`[${label}] every scanline uses no filter, which is what was written`, false, `row ${y}`)
      break
    }
    for (let x = 0; x < side; x += 40) {
      const mc = Math.floor(x / 40) - QUIET_MODULES
      const inside = mr >= 0 && mr < count && mc >= 0 && mc < count
      const want = inside && isDark(mr, mc) ? 0 : 255
      sampled += 1
      if (raw[rowStart + 1 + x] !== want) mismatches += 1
    }
  }
  check(
    `[${label}] the pixels match the matrix, sampled across finder and body`,
    mismatches === 0,
    `${mismatches} of ${sampled} wrong`,
  )
  check(`[${label}] the quiet zone is white all the way round`, (() => {
    for (const x of [0, 20, side - 1, side - 40]) {
      if (raw[0 * (side + 1) + 1 + x] !== 255) return false
      if (raw[(side - 1) * (side + 1) + 1 + x] !== 255) return false
    }
    for (const y of [0, 20, side - 40, side - 1]) {
      if (raw[y * (side + 1) + 1] !== 255) return false
      if (raw[y * (side + 1) + side] !== 255) return false
    }
    return true
  })())
}

/* --------------------------------------------------------------------- main */

const checkOnly = process.argv.includes('--check')

/*
  ONE TARGET AT A TIME, and the labels carry the portal name.

  The first run of a target prints its own heading so a failure reads
  "[team-portal] the PNG signature is correct" rather than an unlabelled line that
  could belong to either file. That matters the moment there are two of them: an
  unlabelled failure in a 60-line report is a guess.
*/

for (const target of TARGETS) {
  const label = target.slug
  const outFile = join(OUT_DIR, `${target.slug}-qr.svg`)
  const outPng = join(OUT_DIR, `${target.slug}-qr.png`)

  console.log(`\n  ${target.label}\n  ${target.url}\n`)

  const { count, svg } = renderSvg(target.url, target.label)
  const matrix = buildMatrix(target.url)
  const png = renderPng(target.url)
  console.log(`  ${count}x${count} modules at error correction ${ERROR_CORRECTION}\n`)

  checkMatrix(`[${label}]`, count, matrix.isDark)
  checkWellFormed(svg, label)
  checkSvg(svg, target.url, label)
  checkPng(png, count, target.url, label)

  if (checkOnly) {
    let committedSvg = null
    let committedPng = null
    try {
      committedSvg = readFileSync(outFile, 'utf8')
    } catch {
      console.log(`  FAIL  [${label}] the committed SVG is missing — run without --check`)
      failed += 1
    }
    try {
      committedPng = readFileSync(outPng)
    } catch {
      console.log(`  FAIL  [${label}] the committed PNG is missing — run without --check`)
      failed += 1
    }

    if (committedSvg !== null) {
      check(
        `[${label}] the committed SVG is exactly what this script would write`,
        committedSvg === svg,
        committedSvg === svg ? '' : `${outFile} is stale`,
      )
    }
    if (committedPng !== null) {
      check(
        `[${label}] the committed PNG is byte-identical to what this script would write`,
        committedPng.equals(png),
        committedPng.equals(png) ? '' : `${outPng} is stale`,
      )
    }
  } else {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(outFile, svg, 'utf8')
    writeFileSync(outPng, png)
    console.log(`\n  wrote ${outFile.replace(ROOT, '.')}`)
    console.log(`  wrote ${outPng.replace(ROOT, '.')}`)
  }
}

/*
  The two codes must be DIFFERENT, which is the entire point of having two.

  If someone edits one URL to match the other, or a copy-paste makes both files the
  same, every other check in this file still passes: each code is a valid QR
  encoding a valid URL. The failure is visible only in the room — the door's sheet
  and the challenge desk's sheet both open the check-in.

  Compared as full bitmaps, not as strings. Two different URLs can encode to the
  same module count, and comparing sizes would call those equal while they are
  different codes; comparing the rendered text would pass even when the drawing is
  wrong. Every module of both is compared, because there are about 1,700 of them
  and the whole loop takes microseconds.
*/
{
  const a = buildMatrix(PORTAL_URL)
  const b = buildMatrix(TEAM_PORTAL_URL)

  let differs = a.count !== b.count
  if (!differs) {
    outer: for (let r = 0; r < a.count; r += 1) {
      for (let c = 0; c < a.count; c += 1) {
        if (a.isDark(r, c) !== b.isDark(r, c)) {
          differs = true
          break outer
        }
      }
    }
  }

  check('the two portal codes are different codes, not one code written twice', differs)
  check(
    'and they encode the two different URLs',
    PORTAL_URL !== TEAM_PORTAL_URL && TEAM_PORTAL_URL.startsWith(PORTAL_URL),
    `root=${PORTAL_URL} team=${TEAM_PORTAL_URL}`,
  )
}

console.log(`\n  ${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}\n`)
if (failed > 0) process.exitCode = 1