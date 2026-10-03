import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db } from './_lib/db.ts'
import {
  createSession,
  currentSession,
  destroySession,
  hashPassword,
  purgeExpiredSessions,
  verifyPassword,
} from './_lib/auth.ts'
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  isTrue,
  json,
  notFound,
  readJson,
  requireString,
  unauthorized,
  unprocessable,
} from './_lib/http.ts'
import {
  isValidSen,
  normalisePhone,
  normaliseSen,
  passwordProblem,
  phoneProblem,
} from './_lib/identifiers.ts'
import { readTicket, signSen } from './_lib/ticket.ts'
import {
  RateLimited,
  consumeResetAttempt,
  dummyPasswordWork,
  purgeOldResetAttempts,
  setRetryAfter,
} from './_lib/reset.ts'

/**
 * The whole API as one serverless function.
 *
 * A single function rather than fifteen: fewer cold starts, and the whole
 * request surface stays readable in one place. Vercel routes `/api/*` here via
 * the `[...route]` catch-all.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // Normalise: `/api/attendee/login` -> ['attendee', 'login']
  const path = routeSegments(req)
  const method = (req.method ?? 'GET').toUpperCase()

  try {
    // Housekeeping. Indexed, so cheap; keeps the tables from growing forever.
    if (Math.random() < 0.02) {
      void purgeExpiredSessions().catch(() => {})
      void purgeOldResetAttempts().catch(() => {})
    }

    await route(req, res, method, path)
  } catch (error) {
    if (error instanceof ApiError) {
      /*
        Omit `message` when it is just the code repeated back.

        `ApiError` defaults its message to the code, so a call like
        `conflict('phone_taken')` would otherwise serialise
        `{ code: 'phone_taken', message: 'phone_taken' }`. The client does
        `message ?? PORTAL_ERROR_MESSAGES[code]`, so a redundant message is
        worse than none: it wins over the friendly copy and the UI renders the
        literal string `phone_taken`. Eight throw sites relied on this default,
        including the two a gate operator reads mid-queue — `unknown_sen` and
        `already_checked_in`.

        Emitting only the code leaves `message` absent, which lets the consumer
        choose the wording appropriate to its own context.
      */
      const redundant = error.message === error.code
      json(res, error.status, redundant
        ? { code: error.code }
        : { code: error.code, message: error.message })
      return
    }

    // Never leak internals (SQL text, connection strings) to the client.
    console.error('[api] unhandled', path.join('/'), error)
    json(res, 500, { code: 'unknown', message: 'Something went wrong. Please try again.' })
  }
}

/* ------------------------------------------------------------------ router */

/**
 * Derives the route from the raw request URL.
 *
 * Deliberately does not rely on `req.query`. The `@vercel/node` types and the
 * legacy `api/` directory populate it, but a Build Output API function is
 * handed a plain Node request with no `query` at all — depending on it fails
 * at runtime with "Cannot read properties of undefined" on every endpoint.
 * The URL is the one source that is always present, and it also survives
 * percent-encoding intact via `decodeURIComponent`.
 */
function routeSegments(req: VercelRequest): string[] {
  const raw = req.url ?? ''
  // `url` may be absolute (proxy-style) or path-only; both are handled by
  // anchoring on the first slash after any scheme+host.
  const withoutOrigin = raw.replace(/^[a-z]+:\/\/[^/]*/i, '')
  const pathname = withoutOrigin.split('?')[0] ?? ''

  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        // Malformed percent-encoding must not throw here; let it 404.
        return segment
      }
    })
    // The `api` prefix is stripped because the function is mounted at `/api`.
    .filter((segment, index) => !(index === 0 && segment === 'api'))
}

type AttendeeRow = {
  id: string
  name: string
  phone: string
  sen: string
  password_hash: string
  created_at: string
}

const publicAttendee = (row: AttendeeRow) => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  sen: row.sen,
  createdAt: row.created_at,
})

/**
 * The one message a password reset ever returns.
 *
 * Shared by both outcomes on purpose. Any wording that differs between "that
 * number exists" and "it does not" turns the endpoint into a roster oracle,
 * which matters because the reset itself is unverified.
 */
const RESET_DONE =
  'If that number is registered, its password has been reset. Log in with your new password.'

async function route(
  req: VercelRequest,
  res: VercelResponse,
  method: string,
  path: string[],
): Promise<void> {
  const [group, action, ...rest] = path
  const key = `${method} /${path.join('/')}`

  /* -- public programme data -------------------------------------------- */
  if (key === 'GET /event') {
    return sendEvent(res)
  }
  if (key === 'GET /teams') {
    // Teams are an organiser concern. Exposed publicly because the admin
    // portal is the only consumer and it holds a session anyway, but a
    // dedicated admin route exists below for that.
    const { rows } = await db().query(
      'select id, name, lead_name, members from teams order by sort_order',
    )
    return json(
      res,
      200,
      rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        name: r.name,
        leadName: r.lead_name,
        members: r.members,
      })),
    )
  }

  /* -- attendee --------------------------------------------------------- */
  if (group === 'attendee') {
    const session = await currentSession(req, 'attendee')
    const requireSession = () => {
      if (!session) throw unauthorized('Please sign in again.')
      return session.subject_id
    }

    switch (key) {
      case 'GET /attendee/session': {
        if (!session) return json(res, 200, null)
        const { rows } = await db().query<AttendeeRow>(
          'select id, name, phone, sen, password_hash, created_at from attendees where id = $1',
          [session.subject_id],
        )
        const row = rows[0]
        if (!row) return json(res, 200, null)
        return json(res, 200, { attendee: publicAttendee(row) })
      }

      case 'POST /attendee/login': {
        const body = await readJson<Record<string, unknown>>(req)
        const name = requireString(body, 'name').trim()
        const phone = normalisePhone(requireString(body, 'phone'))
        const password = requireString(body, 'password')

        const { rows } = await db().query<AttendeeRow>(
          'select id, name, phone, sen, password_hash, created_at from attendees where phone = $1',
          [phone],
        )
        const row = rows[0]

        // One message for every failure, so the endpoint cannot be used to
        // discover which phone numbers are registered.
        const nameMatches =
          row !== undefined && row.name.toLowerCase() === name.toLowerCase()

        if (!nameMatches || !(await verifyPassword(password, row.password_hash))) {
          throw unauthorized('Those credentials do not match our records.')
        }

        await createSession(res, 'attendee', row.id, isTrue(body.remember))
        return json(res, 200, { attendee: publicAttendee(row) })
      }

      case 'POST /attendee/register': {
        const body = await readJson<Record<string, unknown>>(req)
        const name = requireString(body, 'name').trim()
        const phone = normalisePhone(requireString(body, 'phone'))
        const password = requireString(body, 'password')
        const sen = normaliseSen(requireString(body, 'sen'))

        const phoneProblemMessage = phoneProblem(phone)
        if (phoneProblemMessage !== null) {
          throw unprocessable('unknown', phoneProblemMessage)
        }
        if (!isValidSen(sen)) {
          throw unprocessable('unknown', 'Enter a valid SEN, e.g. A866175000012.')
        }
        const problem = passwordProblem(password)
        if (problem) throw unprocessable('weak_password', problem)

        // Unique constraints on phone and sen are the real guard; this check
        // only exists to return a specific error instead of a 500.
        const clash = await db().query(
          'select (select 1 from attendees where phone = $1) as phone_taken,' +
            '       (select 1 from attendees where upper(sen) = $2) as sen_taken',
          [phone, sen],
        )
        const taken = clash.rows[0] as { phone_taken: number | null; sen_taken: number | null }
        if (taken.phone_taken) throw conflict('phone_taken')
        if (taken.sen_taken) throw conflict('sen_taken')

        const { rows } = await db().query<AttendeeRow>(
          `insert into attendees (name, phone, sen, password_hash)
           values ($1, $2, $3, $4)
           returning id, name, phone, sen, password_hash, created_at`,
          [name, phone, sen, await hashPassword(password)],
        )
        const created = rows[0]
        if (!created) throw unprocessable('unknown', 'Could not create the account.')

        // Registration always keeps the attendee signed in, regardless of the
        // "remember me" checkbox: they have just proved who they are and will
        // need their QR pass again on the day, which may be weeks away. Signing
        // them out when the browser closes would lose the pass.
        await createSession(res, 'attendee', created.id, true)
        return json(res, 201, { attendee: publicAttendee(created) })
      }

      case 'POST /attendee/logout': {
        await destroySession(req, res, 'attendee')
        return json(res, 200, { ok: true })
      }

      case 'GET /attendee/ticket': {
        const id = requireSession()
        const { rows } = await db().query<{ sen: string }>(
          'select sen from attendees where id = $1',
          [id],
        )
        const row = rows[0]
        if (!row) throw notFound()
        const code = signSen(row.sen)
        return json(res, 200, { code, encoded: code })
      }

      case 'GET /attendee/attendance': {
        // Null rather than 401: the dashboard renders "not marked yet", and a
        // session that expired mid-view should not turn into an error.
        if (!session) return json(res, 200, null)
        const { rows } = await db().query(
          // Aliased to camelCase to match the `CheckIn` contract. The admin
          // log resolves each row to a person via `attendeeId`, so leaving it
          // snake_case renders every row without a name.
          'select id, sen, attendee_id as "attendeeId", gate, at, method from attendance where attendee_id = $1',
          [session.subject_id],
        )
        return json(res, 200, rows[0] ?? null)
      }

      /*
        Password reset — UNVERIFIED, by the organiser's explicit decision.

        There is no OTP, no email and no security question: knowing the phone
        number is enough. That is a real account-takeover path and is documented
        as such in the README. What this endpoint does do is refuse to be
        scripted:

          - every attempt is rate limited per number AND per caller IP
          - the response is identical whether or not the number is registered,
            so it cannot be used to enumerate the roster
          - a failed lookup burns comparable CPU, so response time does not
            leak existence either
          - a successful reset kills that attendee's existing sessions, so a
            takeover is visible to the person it displaced

        Attendee-only. There is deliberately no admin equivalent: staff
        credentials are reset out of band, not over the public API.
      */
      case 'POST /attendee/password/reset': {
        const body = await readJson<Record<string, unknown>>(req)
        const phone = normalisePhone(requireString(body, 'phone'))
        const password = requireString(body, 'password')

        const phoneProblemMessage = phoneProblem(phone)
        if (phoneProblemMessage !== null) {
          throw unprocessable('unknown', phoneProblemMessage)
        }
        const problem = passwordProblem(password)
        if (problem) throw unprocessable('weak_password', problem)

        try {
          await consumeResetAttempt(req, phone)
        } catch (cause) {
          if (cause instanceof RateLimited) {
            setRetryAfter(res, cause.retryAfterSeconds)
            throw new ApiError(429, 'rate_limited', cause.message)
          }
          throw cause
        }

        const { rows } = await db().query<{
          id: string
          password_hash: string
        }>('select id, password_hash from attendees where phone = $1', [phone])

        const row = rows[0]

        if (!row) {
          // Uniform response, comparable cost. The caller learns nothing about
          // whether this number exists.
          await dummyPasswordWork()
          return json(res, 200, { ok: true, message: RESET_DONE })
        }

        await db().query('update attendees set password_hash = $2 where id = $1', [
          row.id,
          await hashPassword(password),
        ])

        // Any session the previous password minted is now worthless.
        await db().query(`delete from sessions where kind = 'attendee' and subject_id = $1`, [
          row.id,
        ])

        // Deliberately NOT clearing this number's attempt history here. An
        // earlier version did, which meant every successful reset wiped its own
        // counter — so the rate limit never engaged and a caller could reset the
        // same account indefinitely. Counting the successful attempt is the
        // whole point: guessing right must not buy unlimited attempts.
        return json(res, 200, { ok: true, message: RESET_DONE })
      }
    }
  }

  /* -- admin ------------------------------------------------------------ */
  if (group === 'admin') {
    const session = await currentSession(req, 'admin')
    const requireAdmin = () => {
      if (!session) throw forbidden('Log in to the admin portal.')
      return session.subject_id
    }

    switch (key) {
      case 'GET /admin/session': {
        if (!session) return json(res, 200, null)
        const { rows } = await db().query<{
          id: string
          username: string
          display_name: string
        }>('select id, username, display_name from admins where id = $1', [
          session.subject_id,
        ])
        const row = rows[0]
        if (!row) return json(res, 200, null)
        return json(res, 200, {
          admin: { id: row.id, username: row.username, displayName: row.display_name },
        })
      }

      case 'POST /admin/login': {
        const body = await readJson<Record<string, unknown>>(req)
        const username = requireString(body, 'username').trim()
        const password = requireString(body, 'password')

        const { rows } = await db().query<{
          id: string
          username: string
          display_name: string
          password_hash: string
        }>('select id, username, display_name, password_hash from admins where username = $1', [
          username,
        ])
        const row = rows[0]

        if (!row || !(await verifyPassword(password, row.password_hash))) {
          throw unauthorized('Those credentials do not match our records.')
        }

        await createSession(res, 'admin', row.id, true)
        return json(res, 200, {
          admin: { id: row.id, username: row.username, displayName: row.display_name },
        })
      }

      case 'POST /admin/logout': {
        await destroySession(req, res, 'admin')
        return json(res, 200, { ok: true })
      }

      case 'GET /admin/attendees': {
        requireAdmin()
        const { rows } = await db().query<AttendeeRow>(
          'select id, name, phone, sen, password_hash, created_at from attendees order by created_at',
        )
        return json(res, 200, rows.map(publicAttendee))
      }

      case 'GET /admin/attendance': {
        requireAdmin()
        const { rows } = await db().query(
          'select id, sen, attendee_id as "attendeeId", gate, at, method from attendance order by at',
        )
        return json(res, 200, rows)
      }

      case 'POST /admin/attendance': {
        requireAdmin()
        const body = await readJson<Record<string, unknown>>(req)
        const raw = typeof body.sen === 'string' ? body.sen : ''

        // A QR scan carries a signature that proves the pass was issued by us.
        // A bare SEN — typed by staff, or read off a printed barcode — does not,
        // and is admitted as a fallback so the door never stalls. Both are
        // recorded, so an audit can tell a genuine pass from a guess.
        const { sen, method: admission } = readTicket(raw)

        if (!isValidSen(sen)) throw unprocessable('unknown_sen')

        const { rows: found } = await db().query<{ id: string }>(
          'select id from attendees where upper(sen) = $1',
          [sen],
        )
        const attendee = found[0]
        if (!attendee) throw unprocessable('unknown_sen')

        // ATOMIC. The unique index on attendance(attendee_id) is the real
        // guard, so two scanners hitting the same badge at the same instant
        // cannot both insert. A SELECT-then-INSERT would have a window here.
        const { rows: inserted } = await db().query<{
          id: string
          sen: string
          // Must match the SQL alias below. Declaring the row as
          // `attendee_id` while the query aliases it to `attendeeId` compiles
          // cleanly and then reads `undefined` at runtime.
          attendeeId: string
          gate: string
          at: string
          method: string
        }>(
          `insert into attendance (sen, attendee_id, gate, method)
           select sen, id, 'Gate A', $2 from attendees where id = $1
           on conflict (attendee_id) do nothing
           returning id, sen, attendee_id as "attendeeId", gate, at, method`,
          [attendee.id, admission],
        )

        const record = inserted[0]
        if (!record) throw conflict('already_checked_in')

        const { rows: person } = await db().query<AttendeeRow>(
          'select id, name, phone, sen, password_hash, created_at from attendees where id = $1',
          [record.attendeeId],
        )
        const attendeeRow = person[0]
        if (!attendeeRow) throw notFound()

        return json(res, 201, { ...record, attendee: publicAttendee(attendeeRow) })
      }

      case 'PATCH /admin/event': {
        requireAdmin()
        const body = await readJson<Record<string, unknown>>(req)
        const phase = body.phase
        if (phase !== 'registration' && phase !== 'live' && phase !== 'completed') {
          throw badRequest('unknown', 'Invalid phase.')
        }
        return sendEvent(res, phase)
      }

      case 'GET /admin/agenda':
      case 'PATCH /admin/agenda': {
        requireAdmin()
        return sendEvent(res)
      }
    }

    // PATCH /admin/agenda/:id
    if (method === 'PATCH' && group === 'admin' && action === 'agenda' && rest[0]) {
      requireAdmin()
      const id = rest[0]
      const body = await readJson<Record<string, unknown>>(req)
      const status = body.status
      if (status !== 'done' && status !== 'live' && status !== 'upcoming') {
        throw badRequest('unknown', 'Invalid status.')
      }
      const { rows: updated } = await db().query<{
        id: string
        starts_at: string
        title: string
        speaker: string
        room: string
        status: string
      }>(
        `update agenda set status = $2
           where id = $1
         returning id, starts_at, title, speaker, room, status`,
        [id, status],
      )
      const item = updated[0]
      if (!item) throw notFound('That agenda item does not exist.')

      // Returns the single updated item, matching the client contract. The
      // event phase endpoint returns the whole event because that is what the
      // caller replaces its state with; here the caller patches one row.
      return json(res, 200, {
        id: item.id,
        startsAt: item.starts_at,
        title: item.title,
        speaker: item.speaker,
        room: item.room,
        status: item.status,
      })
    }
  }

  throw notFound('No such endpoint.')
}

/* ----------------------------------------------------------------- helpers */

async function sendEvent(res: VercelResponse, phase?: 'registration' | 'live' | 'completed'): Promise<void> {
  if (phase) {
    await db().query('update events set phase = $1 where id = $2', [
      phase,
      'evt_awakening_2026',
    ])
  }

  const { rows: eventRows } = await db().query(
    // `to_char` rather than letting node-pg turn a DATE into a JS Date: that
    // conversion goes through local midnight, so a server west of UTC would
    // report the event a day early. Formatting in Postgres keeps the calendar
    // date exactly as it was entered.
    `select id, name, tagline, organiser, organiser_host,
            to_char(date, 'YYYY-MM-DD')     as date,
            to_char(end_date, 'YYYY-MM-DD') as end_date,
            venue, city, phase, capacity
       from events order by date desc limit 1`,
  )
  const event = eventRows[0] as
    | {
        id: string
        name: string
        tagline: string
        organiser: string
        organiser_host: string | null
        date: string
        end_date: string | null
        venue: string
        city: string
        phase: string
        capacity: number
      }
    | undefined

  if (!event) throw notFound('No event configured.')

  const { rows: agenda } = await db().query(
    `select id, day, starts_at, title, speaker, room, status
       from agenda where event_id = $1 order by sort_order`,
    [event.id],
  )

  return json(res, 200, {
    id: event.id,
    name: event.name,
    tagline: event.tagline,
    organiser: event.organiser,
    organiserHost: event.organiser_host ?? undefined,
    // Already YYYY-MM-DD strings courtesy of `to_char`; no timezone maths here.
    date: event.date,
    endDate: event.end_date ?? undefined,
    venue: event.venue,
    city: event.city,
    phase: event.phase,
    capacity: event.capacity,
    agenda: agenda.map((item: Record<string, unknown>) => ({
      id: item.id,
      day: item.day,
      startsAt: item.starts_at,
      title: item.title,
      speaker: item.speaker,
      room: item.room,
      status: item.status,
    })),
  })
}