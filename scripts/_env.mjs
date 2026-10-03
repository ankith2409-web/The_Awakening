/**
 * Loads `.env` into `process.env` for scripts run outside Vercel.
 *
 * Vercel injects environment variables itself, so this is a no-op in
 * production. It exists for local scripts, where the alternative is remembering
 * to prefix every command with `$env:DATABASE_URL = ...` — and forgetting,
 * which fails with a bare "DATABASE_URL is not set" that looks like a bug in
 * the script rather than a missing shell variable.
 *
 * Existing process.env values always win, so an explicitly-set variable is
 * never clobbered by the file.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function loadEnv() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  let raw
  try {
    raw = readFileSync(join(root, '.env'), 'utf8')
  } catch {
    return // no .env; rely on the real environment
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue

    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()

    // Strip matching quotes, so a value may contain spaces or a URL safely.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    if (process.env[key] === undefined) process.env[key] = value
  }
}
