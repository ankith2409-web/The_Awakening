#!/usr/bin/env node
/**
 * Inlines a brand mark into `server/_lib/brand.ts` as a `data:` URI.
 *
 *   node scripts/embed-brand.mjs brand/gdg-oc-amity.png chapterLogo
 *
 * WHY A GENERATOR RATHER THAN A COMMITTED BINARY.
 *
 * The alternative is to link `/brand/gdg-oc-amity.png` from the email, which is the
 * one thing that does not work: mail clients block remote images by default, so the
 * logo arrives for nobody. A `data:` URI is part of the message and cannot be
 * withheld.
 *
 * Putting a megabyte of base64 in a hand-edited source file is nobody's idea of a
 * good afternoon, and a logo replaced by drag-and-drop should not require anyone to
 * remember this command. So the file is a placeholder until somebody runs this, and
 * the place it writes is the only place a base64 blob belongs.
 *
 * IT RE-WRITES BOTH MARKS' LINES AND NOTHING ELSE.
 *
 * Anchored on the two `export const ...Logo` declarations by name, so the prose
 * around them — which is most of the file — cannot be lost to a careless replace.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'server', '_lib', 'brand.ts')

const [imagePath, which] = process.argv.slice(2)

if (!imagePath || !which) {
  console.error(
    '\n  Usage: node scripts/embed-brand.mjs <image-file> <chapterLogo|fetchAiLogo>\n',
  )
  process.exit(1)
}

if (!['chapterLogo', 'fetchAiLogo'].includes(which)) {
  console.error(`\n  "${which}" is not a known mark. Use chapterLogo or fetchAiLogo.\n`)
  process.exit(1)
}

const absolute = imagePath.startsWith('/') || /^[A-Za-z]:/.test(imagePath)
  ? imagePath
  : join(ROOT, imagePath)

if (!existsSync(absolute)) {
  console.error(`\n  No such file: ${absolute}\n`)
  process.exit(1)
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}[extname(absolute).toLowerCase()]

if (!MIME) {
  console.error(`\n  ${extname(absolute)} is not an image type mail will render.\n`)
  process.exit(1)
}

const bytes = readFileSync(absolute)
const uri = `data:${MIME};base64,${bytes.toString('base64')}`

let source = readFileSync(TARGET, 'utf8')

/*
  Matched by the declaration, not by the value.

  The existing line may be `export const chapterLogo: string | null = null` or a
  thousand-character base64 blob, and matching on either shape would fail as soon as
  somebody ran this twice. The declaration is the only stable text.
*/
const pattern = new RegExp(`(export const ${which}: string \\| null = )[^\\n]*`)

if (!pattern.test(source)) {
  console.error(`\n  Could not find "export const ${which}" in ${TARGET}.\n`)
  process.exit(1)
}

source = source.replace(pattern, `$1'${uri}'`)
writeFileSync(TARGET, source, 'utf8')

const kb = (bytes.length / 1024).toFixed(1)
console.log(`\n  ${which} <- ${imagePath}`)
console.log(`  ${kb}KB of image, ${(uri.length / 1024).toFixed(1)}KB base64 inlined`)
console.log(`  written to server/_lib/brand.ts\n`)
