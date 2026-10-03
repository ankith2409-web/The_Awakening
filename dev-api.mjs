import { createServer } from 'node:http'
import { loadEnv } from './scripts/_env.mjs'

/**
 * Local harness for the serverless function.
 *
 * Intentionally minimal: it replays the request body and adds nothing to the
 * request or response objects. It does NOT populate `req.query`/`req.cookies`
 * and does NOT add a `res.status()` helper, because the real Build Output
 * launcher doesn't either — the response is a plain Node `ServerResponse`.
 * Anything the handler leans on has to come from `req.url`, `req.headers` and
 * `res.statusCode`. Faking these here would let the handler pass locally and
 * fail in production, which is precisely the class of bug this harness exists
 * to surface.
 *
 * It loads `.env` so DATABASE_URL, TICKET_SECRET and the admin credentials come
 * from one place. Forgetting to export TICKET_SECRET inline once cost a
 * confusing 500 from `/attendee/ticket` that read like a code regression but was
 * only a missing environment variable.
 *
 * Test-only. Vercel runs the esbuild bundle produced by scripts/build-vercel.mjs.
 */
loadEnv()

const { default: handler } = await import('./server/[...route].ts')

const server = createServer(async (req, res) => {
  // Buffer, then replay: the handler reads the body as a stream, and a
  // consumed stream reads as empty, which turns every POST into a 400.
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const buffered = Buffer.concat(chunks)

  req[Symbol.asyncIterator] = async function* replay() {
    yield buffered
  }

  const mockRes = {
    statusCode: 200,
    setHeader(key, value) {
      res.setHeader(key, value)
    },
    getHeader(key) {
      return res.getHeader(key)
    },
    end(body) {
      res.statusCode = this.statusCode
      res.end(body)
    },
  }

  try {
    await handler(req, mockRes)
  } catch (error) {
    res.statusCode = 500
    res.end(JSON.stringify({ code: 'unknown', message: String(error && error.message) }))
  }
})

server.listen(3000, () => console.log('test server on :3000'))
