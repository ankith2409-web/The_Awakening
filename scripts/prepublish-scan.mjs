#!/usr/bin/env node
/**
 * Pre-publish secret scan.
 *
 * Runs the same check you want before every `git push`, because the cost of
 * leaking the Neon connection string is not recoverable by deleting the commit:
 * anyone who cloned in the window has it, and it must be rotated.
 *
 * It scans exactly what git WOULD commit — `git ls-files` plus untracked-but-not
 * ignored files — rather than the whole directory, because `.env` and
 * `.vercel/` are expected to exist locally and are not the thing being checked.
 * What matters is that none of their contents reach the remote.
 *
 *   node scripts/prepublish-scan.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|zip|gz|pdf)$/i

/*
  Patterns worth refusing to publish.

  Each is specific enough that a false positive means you should look, and broad
  enough that a real leak cannot slip through by being formatted unusually.
*/
const RULES = [
  {
    name: 'Postgres connection string',
    // Any scheme, any credentials, any host.
    pattern: /postgres(?:ql)?:\/\/[^\s'"`]+/gi,
    /*
      Placeholders are not secrets. Two forms appear in committed files: the
      `.env.example` template (`postgresql://user:password@host/...`) and the
      shell snippets in `setup-db.mjs` (`postgresql://...`). Both are ellipses a
      reader fills in. A pattern that flagged them would train you to ignore the
      scanner's output, which is worse than having none.
    */
    allow: (m) =>
      /postgres(?:ql)?:\/\/user:password@host/i.test(m) ||
      /postgres(?:ql)?:\/\/\.\.\./i.test(m) ||
      /postgres(?:ql)?:\/\/$/i.test(m),
  },
  {
    name: 'Neon project key',
    pattern: /\bnpg_[A-Za-z0-9_-]{16,}/g,
  },
  {
    name: 'Vercel token',
    pattern: /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    name: 'AWS access key id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    name: 'Private key block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'Bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g,
  },
  {
    // Matches the SHAPE of this project's admin password rather than the value.
    // Spelling the password out inside the scanner that exists to catch it would
    // make the scanner itself the leak — and this file is published.
    name: 'Admin password literal',
    pattern: /Awaken-GDG-\d{4}-[A-Za-z0-9]{4}/g,
  },
]

function gitFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  )
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
}

if (!existsSync('.git')) {
  console.error('\n  No git repository yet — nothing to scan.\n')
  process.exit(1)
}

const files = gitFiles()
const findings = []
let scanned = 0

for (const file of files) {
  if (BINARY.test(file)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  scanned += 1

  for (const rule of RULES) {
    // Fresh lastIndex per file: these are global regexes.
    rule.pattern.lastIndex = 0
    let m
    while ((m = rule.pattern.exec(text)) !== null) {
      if (rule.allow && rule.allow(m[0])) continue
      const line = text.slice(0, m.index).split('\n').length
      // Show a shape, not the secret itself.
      const shape = m[0].slice(0, 12).replace(/[^A-Za-z0-9]/g, '·')
      findings.push({ file, line, rule: rule.name, shape })
    }
  }
}

console.log(`\n  Scanned ${scanned} of ${files.length} files that git would publish.\n`)

if (findings.length === 0) {
  console.log('  No secrets found. Safe to push.\n')
} else {
  console.log(`  ${findings.length} potential secret(s):\n`)
  for (const f of findings) {
    console.log(`    ${f.file}:${f.line}  ${f.rule}  [${f.shape}…]`)
  }
  console.log('\n  Do not push. Remove the value, or add the path to .gitignore.\n')
  process.exitCode = 1
}

/*
  Files that must never exist in the repository at all, regardless of content.
  Checked separately: a tracked `.env` full of placeholders would still be a
  tracked `.env`, and someone will eventually paste a real value into it.
*/
const forbidden = ['.env', '.vercel', 'node_modules', 'dist']
const tracked = new Set(files)
const present = forbidden.filter((f) => tracked.has(f))

if (present.length > 0) {
  console.log(`  TRACKED BUT MUST NOT BE: ${present.join(', ')}\n`)
  process.exitCode = 1
} else {
  console.log(`  Confirmed absent from the publish set: ${forbidden.join(', ')}\n`)
}