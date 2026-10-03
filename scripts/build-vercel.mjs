#!/usr/bin/env node
/**
 * Emits a Vercel Build Output API v3 directory.
 *
 * Why this exists: Vercel only builds an `api/` directory for Next.js. For a
 * Vite project the functions are silently skipped and every `/api/*` request
 * falls through to the SPA rewrite — which returns HTTP 200 and the HTML
 * shell, so the failure looks like a working endpoint rather than a missing
 * one. Pinning `"framework": null` does not change this.
 *
 * The backend source therefore lives in `server/`, NOT `api/`. Leaving it in
 * `api/` makes Vercel build a second, unstripped copy of the function that
 * shadows this one at runtime — the deployment looks successful and then fails
 * with ERR_MODULE_NOT_FOUND on the first request.
 *
 * The Build Output API is the supported route for framework-less projects, so
 * this script assembles it explicitly:
 *
 *   .vercel/output/
 *     config.json                  routes + framework
 *     static/                      the built client
 *     functions/api/route.func/    the serverless function
 */

import { build } from 'esbuild'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.vercel', 'output')
const funcDir = join(out, 'functions', 'api', 'route.func')

async function main() {
  await rm(out, { recursive: true, force: true })
  await mkdir(funcDir, { recursive: true })
  await mkdir(join(out, 'static'), { recursive: true })

  /* -- static client ---------------------------------------------------- */
  await cp(join(root, 'dist'), join(out, 'static'), { recursive: true })

  /* -- function --------------------------------------------------------- */
  await build({
    entryPoints: [join(root, 'server', '[...route].ts')],
    outfile: join(funcDir, 'index.js'),
    bundle: true,
    platform: 'node',
    // Vercel's Node runtime. Must match `.vc-config.json` below; nodejs20.x
    // is discontinued on the platform and rejected at deploy time.
    target: 'node22',
    // CommonJS, not ESM. Vercel's Node launcher `require()`s the handler as
    // `index.js`, so an ESM bundle dies with "Cannot use import statement
    // outside a module" on the very first request — while the deployment
    // itself reports as READY.
    format: 'cjs',
    // `pg` and `bcryptjs` must be BUNDLED. A Build Output function is uploaded
    // standalone: unlike a Next.js lambda it has no node_modules beside it, so
    // leaving them external resolves to "Cannot find module" at runtime.
    //
    // Only the optional native transports stay external — pg conditionally
    // requires them and they never exist on Vercel's Linux runtime.
    external: ['pg-native', 'pg-cloudflare'],
    minify: true,
    sourcemap: false,
    // Strip types; esbuild handles .ts natively.
    logLevel: 'warning',
  })

  await writeFile(
    join(funcDir, '.vc-config.json'),
    JSON.stringify(
      {
        runtime: 'nodejs22.x',
        handler: 'index.js',
        launcherType: 'Nodejs',
        shouldAddHelpers: false,
        shouldAddSourcemapSupport: false,
      },
      null,
      2,
    ),
  )

  /*
    `filesystem` runs first, so real files (hashed assets) win. The API route
    is matched before the SPA catch-all, so a broken function surfaces as an
    error instead of a 200 with the HTML shell.
  */
  await writeFile(
    join(out, 'config.json'),
    JSON.stringify(
      {
        version: 3,
        routes: [
          { handle: 'filesystem' },
          { src: '/api/(.*)', dest: '/api/route' },
          { src: '/(.*)', dest: '/index.html' },
        ],
        /*
          No `overrides` for asset caching, deliberately.

          Setting `cache-control: immutable` here — or `headers` in vercel.json —
          has no effect: Vercel manages caching for files served from
          `.vercel/output/static` itself and overwrites the value with
          `public, max-age=0, must-revalidate`. Verified against the live
          deployment rather than assumed.

          That default is correct, just not maximal: the browser revalidates with
          an ETag and gets a 304. Immutable caching for hashed assets would need
          a CDN or proxy in front that does not rewrite the header.
        */
      },
      null,
      2,
    ),
  )

  console.log('  built .vercel/output (static + api function)')
}

main().catch((error) => {
  console.error('  Build Output generation failed:', error.message)
  process.exit(1)
})