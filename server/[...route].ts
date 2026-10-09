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
  field,
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
  nameKey,
  nameProblem,
  normalisePhone,
  normaliseSen,
  passwordProblem,
  phoneProblem,
} from './_lib/identifiers.ts'
import { readTicket, signSen } from './_lib/ticket.ts'
import { resolveEventDay, isDayLocked } from './_lib/eventDay.ts'
// Only the reset-attempt ledger purge survives; the limiter itself went with the
// endpoint it protected. See `_lib/reset.ts`.
import { purgeOldResetAttempts } from './_lib/reset.ts'

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
 * Staff access levels.
 *
 * `owner` runs the event: the roster, credentials, the programme. `gate` is a
 * volunteer with a phone at the door: mark attendance, read the log, read teams.
 * Nothing in the codebase may widen a `gate` session.
 *
 * There is exactly one `gate` credential, shared by whoever is on the door. It is
 * provisioned by `scripts/manage-staff.mjs`, not through the API — there used to
 * be a Staff panel for this and it was removed, because managing one shared
 * account is not worth a settings screen, and every route it needed was attack
 * surface for no benefit.
 */
const ADMIN_ROLES = ['owner', 'gate'] as const
type AdminRole = (typeof ADMIN_ROLES)[number]

/**
 * Coerces whatever came out of the database into a known role.
 *
 * The column has a CHECK constraint, so the database cannot store a third value.
 * This exists because the default arm is not paranoia about the CHECK — it is
 * that an unrecognised role must fail CLOSED. A new value silently treated as
 * `owner` would be a privilege escalation, and this function is what decides
 * that, so it defaults to the narrower door.
 */
function adminRole(value: unknown): AdminRole {
  return value === 'gate' ? 'gate' : ADMIN_ROLES.includes(value as AdminRole) ? 'owner' : 'gate'
}

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
        //
        // Compared on `nameKey`, not raw. Case and spacing are typing habits, not
        // identity: somebody who registered as "Mary  Ann" and then typed "Mary Ann"
        // was locked out of their own pass with no way back but emailing the
        // organiser. A different name, a different spelling, or an added middle
        // initial still fails, so the name remains a real second factor.
        const nameMatches = row !== undefined && nameKey(row.name) === nameKey(name)

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

        /*
          The name was previously only checked for being a non-empty string, which
          made the browser form the sole enforcement of a rule that the API is
          supposed to own. Emoji, digits and a 200-character name all wrote straight
          through.
        */
        const nameProblemMessage = nameProblem(name)
        if (nameProblemMessage !== null) {
          throw unprocessable('unknown', nameProblemMessage)
        }
        if (!isValidSen(sen)) {
          throw unprocessable('unknown', 'Enter a valid SEN, e.g. A866175000012.')
        }
        const problem = passwordProblem(password)
        if (problem) throw unprocessable('weak_password', problem)

        /*
          Who may register, and who may not.

          Three modes rather than a boolean, because a boolean could only narrow.
          `open` lets anyone through, `restricted` admits only SENs on the guest
          list, and `closed` stops everyone — the state a portal is in once capacity
          is reached, and the one an organiser most needs on the morning of the day.

          Checked against the roster by SEN only. Matching on the uploaded NAME as
          well would lock out real students over a spelling difference — and the
          name on a college list is exactly the field that gets transcribed wrong.

          Checked BEFORE the uniqueness probes, so somebody refused is told that
          rather than being walked through "that phone number is already registered"
          for a stranger's number.

          The refusal says nothing about how long the list is or who is on it.
          Anything more turns registration into an oracle for who is attending.
        */
        const { rows: gate } = await db().query<{
          on_list: boolean
          mode: 'open' | 'restricted' | 'closed'
        }>(
          `select exists (select 1 from event_roster where sen = $1) as on_list,
                  coalesce(
                    (select registration_mode from events order by date desc limit 1),
                    'open'
                  ) as mode`,
          [sen],
        )

        const mode = gate[0]?.mode ?? 'open'
        if (mode === 'closed') throw unprocessable('registration_closed')
        if (mode === 'restricted' && gate[0]?.on_list !== true) {
          throw unprocessable('not_on_list')
        }

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
          `select id, sen, attendee_id as "attendeeId", at, method, day
             from attendance where attendee_id = $1 order by day`,
          [session.subject_id],
        )

        const dayState = await resolveEventDay()

        /*
          Every record, not just the first, and the day state alongside them.

          This used to return a single row or null, which was correct while
          attendance was once-in-a-lifetime. With a record per day, "the first one"
          is a coin toss: somebody who came on day two would see day one's time,
          and somebody who came on day one only would be told they are marked for
          an event they have not attended yet.

          The dashboard needs `totalDays` to render rows for days that have no
          record yet, so an attendee can see "day two — not yet" rather than an
          absence that reads like nothing at all.
        */
        return json(res, 200, {
          records: rows,
          activeDay: dayState.activeDay,
          totalDays: dayState.totalDays,
          overridden: dayState.overridden,
          /*
            Needed here, not just in the admin payload.

            Without it the dashboard cannot tell the difference between "day one has
            not happened yet" and "day one is closed", and it says the same thing for
            both: show your pass at the gate. On a day that can no longer be marked
            that instruction can never succeed, so somebody who missed it would sit
            watching a status that will never change, told it updates on its own.

            It is not sensitive. It is the same set of day numbers the public event
            payload already carries.
          */
          lockedDays: dayState.lockedDays,
        })
      }

      /*
        There is deliberately no self-service password reset.

        One existed and was UNVERIFIED — no OTP, no email, no security question,
        so knowing a phone number was enough to take over that account and
        present its pass. It was the single most serious weakness in the portal,
        and rate limiting was the only thing between it and a script walking the
        roster. It was also under active probing in production.

        Recovery is now admin-mediated: an attendee asks an organiser at the desk,
        and `POST /admin/attendees/password` below sets a new one. That removes
        the unauthenticated path entirely rather than tightening it.
      */
    }
  }

  /* -- admin ------------------------------------------------------------ */
  if (group === 'admin') {
    const session = await currentSession(req, 'admin')

    /*
      Two levels, and the distinction is the whole point of this file.

      `requireAdmin` proves only that the caller is staff. It is not enough on its
      own for anything that hands out data or changes state: a `gate` account is
      a volunteer with a phone at the door, and it must not be able to read the
      roster, export SENs, edit the programme or reset a credential.

      `requireOwner` is the narrower door. Both are enforced here rather than in
      the client, because the client is a suggestion and a session cookie is not.
    */
    const requireAdmin = () => {
      if (!session) throw forbidden('Log in to the admin portal.')
      return session.subject_id
    }

    const requireOwner = () => {
      const id = requireAdmin()
      if (!adminIsOwner) throw forbidden('Your account cannot make this change.')
      return id
    }

    /*
      The role is read once per request from the row the session already points
      at, and re-read rather than cached in the session token: a demotion has to
      take effect on the next request, not whenever the holder next logs in.
    */
    let adminIsOwner = false
    if (session) {
      const { rows } = await db().query<{ role: string }>(
        'select role from admins where id = $1 and active',
        [session.subject_id],
      )
      adminIsOwner = rows[0]?.role === 'owner'
    }

    switch (key) {
      case 'GET /admin/session': {
        if (!session) return json(res, 200, null)
        const { rows } = await db().query<{
          id: string
          username: string
          display_name: string
          role: string
        }>('select id, username, display_name, role from admins where id = $1 and active', [
          session.subject_id,
        ])
        const row = rows[0]
        // A disabled account holding a live cookie is treated as signed out.
        if (!row) return json(res, 200, null)
        return json(res, 200, {
          admin: {
            id: row.id,
            username: row.username,
            displayName: row.display_name,
            /*
              The role belongs here, not only on the login response.

              This is the endpoint the client calls on every page load to decide
              whether anyone is signed in. Omitting the role made a signed-in
              owner who refreshed the page resolve as `undefined`, which the UI
              treats as the narrower role — so the Staff panel, the Desk and the
              export all vanished until they signed out and back in. The tabs came
              back; the ability to fix the problem did not.
            */
            role: adminRole(row.role),
          },
        })
      }

      case 'POST /admin/login': {
        const body = await readJson<Record<string, unknown>>(req)
        const username = requireString(body, 'username').trim()
        const password = requireString(body, 'password')

        /*
          Matched on `lower(username)`, not `username`.

          Staff accounts get typed by hand on event day, and "Ankith" versus
          "ankith" failing to match looks exactly like a wrong password. The
          unique index is case-insensitive too, so there is never more than one
          account these could both be talking about.
        */
        const { rows } = await db().query<{
          id: string
          username: string
          display_name: string
          password_hash: string
          role: string
          active: boolean
        }>(
          'select id, username, display_name, password_hash, role, active from admins where lower(username) = lower($1)',
          [username],
        )
        const row = rows[0]

        /*
          A disabled account gives the same answer as a wrong password, on purpose.
          Saying "this account is disabled" tells someone probing usernames which
          ones exist, and tells a volunteer who left that their account still works.
        */
        if (!row || !row.active || !(await verifyPassword(password, row.password_hash))) {
          throw unauthorized('Those credentials do not match our records.')
        }

        await createSession(res, 'admin', row.id, true)
        return json(res, 200, {
          admin: {
            id: row.id,
            username: row.username,
            displayName: row.display_name,
            role: adminRole(row.role),
          },
        })
      }

      case 'POST /admin/logout': {
        await destroySession(req, res, 'admin')
        return json(res, 200, { ok: true })
      }

      /*
        The roster. Owner-only.

        This route is the reason the `gate` role exists: it returns every
        attendee's name, phone and SEN in one response, which is the SEN export
        with an extra step. A volunteer at the gate does not need it — the scan
        response names whoever just checked in — so it is not available to them,
        and the client never calls it on their behalf.
      */
      case 'GET /admin/attendees': {
        requireOwner()
        const { rows } = await db().query<AttendeeRow>(
          'select id, name, phone, sen, password_hash, created_at from attendees order by created_at',
        )
        return json(res, 200, rows.map(publicAttendee))
      }

      /*
        Add one attendee by hand.

        Owner-only, and deliberately DELIBERATE rather than convenient. It is the
        only way to create an attendee without the registration form, which means it
        bypasses the guest list — and that is the point. An organiser standing at a
        desk with a student who is not on the list, or with registration closed
        because capacity was reached, has to be able to let that one person in.
        Refusing would leave them with no way to do the one thing they are there to do.

        Which is exactly why it is audited and owner-only. Every other privileged act
        in this product writes to `password_changes` or `staff_changes`, and so does
        this: an account created out of band, with a password the organiser chose, is
        the single most sensitive action available and it leaves a trail.

        The password is SET BY THE ORGANISER and must be read out to the attendee.
        Generating one and displaying it once would be friendlier, but it would also
        put a credential on a screen a passer-by can see, which is the reason the
        desk flow asks staff to read it aloud instead.
      */
      case 'POST /admin/attendees': {
        const adminId = requireOwner()
        const body = await readJson<Record<string, unknown>>(req)

        const name = requireString(body, 'name').trim()
        const phone = normalisePhone(requireString(body, 'phone'))
        const password = requireString(body, 'password')
        const sen = normaliseSen(requireString(body, 'sen'))

        // The same rules the registration form applies, so a person added by hand is
        // held to exactly the same standard as one who signed up. A weaker path here
        // would be a way around every rule added since.
        const nameProblemMessage = nameProblem(name)
        if (nameProblemMessage !== null) throw unprocessable('unknown', nameProblemMessage)

        const phoneProblemMessage = phoneProblem(phone)
        if (phoneProblemMessage !== null) {
          throw unprocessable('unknown', phoneProblemMessage)
        }

        if (!isValidSen(sen)) {
          throw unprocessable('unknown', 'Enter a valid SEN, e.g. A866175000012.')
        }
        const problem = passwordProblem(password)
        if (problem) throw unprocessable('weak_password', problem)

        // Uniqueness is still enforced. An organiser adding somebody by hand is not
        // a request to create a second account for them, and the alternative is a
        // duplicate that quietly doubles a name on the roster.
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

        await recordPasswordChange(adminId, created.id)

        /*
          No session is issued.

          The person is not at this computer, and handing them a cookie would mean
          they were silently signed in on a device they may never see again — and
          signed in without typing the password the organiser just read to them,
          which defeats the point of setting one.
        */
        return json(res, 201, { attendee: publicAttendee(created) })
      }

      /*
        The guest list: who is allowed to register.

        Owner-only, and read-only in the sense that matters — it returns a COUNT and
        a SAMPLE, not the whole list. The full roster is every student's name and
        SEN, which is exactly the data a `gate` account must never receive, and an
        owner who needs to see the lot can download the sheet they uploaded. There
        is no route that returns all of it.
      */
      case 'GET /admin/roster': {
        requireOwner()

        /*
          The list and its size, and nothing about who may register.

          `registration_mode` is deliberately NOT repeated here. The client already
          holds it on `EventInfo`, and returning it a second time would create two
          copies of one fact in two places that could be loaded at different moments
          — which is how a panel ends up showing "restricted" beside a count of zero
          and neither one being wrong.
        */
        const { rows: counts } = await db().query<{
          n: string
          uploaded_at: Date | null
        }>(
          `select (select count(*) from event_roster)::text as n,
                  roster_uploaded_at
             from events order by date desc limit 1`,
        )
        const state = counts[0]

        const { rows: sample } = await db().query<{ sen: string; name: string }>(
          'select sen, name from event_roster order by sen limit 8',
        )

        return json(res, 200, {
          count: Number(state?.n ?? 0),
          uploadedAt: state?.uploaded_at ? state.uploaded_at.toISOString() : null,
          sample,
        })
      }

      /*
        Replace the guest list.

        All-or-nothing, and that is the entire point. Registration depends on this
        table, so a partially-applied upload would lock out whichever half did not
        land — a failure nobody could diagnose from the symptom, because those
        students would simply be told they are not on the list. So every row is
        validated BEFORE anything is written, and the delete plus the insert happen
        in one transaction.

        Replaces rather than merges: an upload is a statement about who may register
        now, and someone who has left must stop being able to. Merging would make a
        list impossible to shrink, which is the correction an organiser most often
        needs to make.
      */
      case 'POST /admin/roster': {
        requireOwner()
        const body = await readJson<Record<string, unknown>>(req)

        const rawRows = body.rows
        if (!Array.isArray(rawRows)) {
          throw badRequest('unknown', 'No rows found in the upload.')
        }

        /*
          A hard ceiling, well above this event's ~500 students.

          The endpoint buffers the request body, so an unbounded array is an
          unbounded allocation. Refusing early is better than accepting 200 000 rows
          and failing later in a way that leaves nothing written and no clue why.
        */
        if (rawRows.length > 5000) {
          throw badRequest('unknown', 'That file has more rows than this portal can hold.')
        }

        const problems: string[] = []
        const accepted: { sen: string; name: string }[] = []
        const seen = new Map<string, number>()

        for (let i = 0; i < rawRows.length; i += 1) {
          const row = rawRows[i] as Record<string, unknown>
          const lineNumber = i + 2 // +2: one-based, and row 1 is the header

          const sen = normaliseSen(field(row.sen))
          // `name` here is the ORGANISER's data, not something a student typed, so it
          // is not held to the registration name rule. It is trimmed and capped so
          // the column cannot hold unbounded text, and stripped of control
          // characters so a spreadsheet cell cannot inject line breaks into the
          // admin roster display.
          const name = field(row.name)
            .replace(/[\u0000-\u001F\u007F]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80)

          if (!isValidSen(sen)) {
            problems.push(`row ${lineNumber}: "${field(row.sen).slice(0, 24)}" is not a valid SEN`)
            continue
          }
          if (name === '') {
            problems.push(`row ${lineNumber}: missing a name`)
            continue
          }

          const firstSeen = seen.get(sen)
          if (firstSeen !== undefined) {
            /*
              A duplicate is a warning, not a rejection.

              The same student twice in one sheet is a spreadsheet slip, and the
              outcome they want is one row — not a failed upload over something the
              organiser cannot see. It is still surfaced, because a sheet with 400
              rows where half are duplicates usually means the wrong range was
              exported.
            */
            problems.push(`row ${lineNumber}: duplicate of row ${firstSeen} (${sen}) — kept the first`)
            continue
          }

          seen.set(sen, lineNumber)
          accepted.push({ sen, name })
        }

        /*
          Every row bad means nothing is written, and the reason is returned in full.

          The common cause is a header the parser did not recognise, which produces
          one "not a valid SEN" per row — so the first few problems plus the count
          is far more use than a generic rejection.
        */
        if (accepted.length === 0) {
          throw unprocessable('unknown', `No usable rows. First problem: ${problems[0] ?? 'the file is empty'}`)
        }

        /*
          The mode travels with the upload.

          Defaulting to `open` when the caller does not say: an upload that silently
          changed who may register would be the worst possible surprise, and `open`
          is the state that admits nobody by omission. The panel always sends it
          explicitly, because it is showing a preview of the consequence anyway.
        */
        const registrationMode = readRegistrationMode(body.registrationMode) ?? 'open'

        const client = await db().connect()
        try {
          await client.query('begin')
          await client.query('delete from event_roster')
          await client.query(
            `insert into event_roster (sen, name)
             select * from unnest($1::text[], $2::text[])`,
            [accepted.map((r) => r.sen), accepted.map((r) => r.name)],
          )
          /*
            The registration MODE is settable here, so uploading a list and choosing
            what it means is one action rather than two. Left alone when absent, so
            an upload never silently changes who may register — the panel always
            sends it explicitly.
          */
          await client.query(
            `update events set registration_mode = $1, roster_uploaded_at = now()
              where id = 'evt_awakening_2026'`,
            [registrationMode],
          )
          await client.query('commit')
        } catch (error) {
          await client.query('rollback').catch(() => {})
          throw error
        } finally {
          client.release()
        }

        return json(res, 200, {
          imported: accepted.length,
          skipped: problems.length,
          problems: problems.slice(0, 10),
          mode: registrationMode,
        })
      }

      /*
        Clear the list.

        Separate from uploading an empty file, because "remove every student" and
        "I uploaded a blank sheet" are different mistakes and only one of them
        should be one click away from done.

        Does NOT change the mode. An organiser who empties the list while registration
        is `restricted` has just closed the door to everybody, and doing that as a
        side effect of clearing a spreadsheet would be a nasty surprise. The mode is
        changed deliberately, from the switch that says what it does.
      */
      case 'DELETE /admin/roster': {
        requireOwner()
        const client = await db().connect()
        try {
          await client.query('begin')
          await client.query('delete from event_roster')
          await client.query(
            `update events set roster_uploaded_at = null where id = 'evt_awakening_2026'`,
          )
          await client.query('commit')
        } catch (error) {
          await client.query('rollback').catch(() => {})
          throw error
        } finally {
          client.release()
        }
        return json(res, 200, { count: 0, uploadedAt: null, sample: [] })
      }

      /*
        Set an attendee's password. The ONLY password-change path in the portal.

        Identified by SEN rather than phone or name: SEN is printed on the badge
        and is already the gate's identifier, so an organiser holding a pass does
        not have to ask someone to spell out a phone number or hope they are the
        only "Ankith" on the roster.

        Three writes, in one transaction. A partial commit here is the failure
        that matters:

          - the new hash lands but sessions survive, so whoever prompted this
            change keeps access and the attendee still cannot get in
          - sessions die but the audit row is lost, so a privileged password
            change leaves no trace

        So either all three happen or none do.
      */
      case 'POST /admin/attendees/password': {
        const adminId = requireOwner()
        const body = await readJson<Record<string, unknown>>(req)
        const sen = normaliseSen(requireString(body, 'sen'))
        const password = requireString(body, 'password')

        if (!isValidSen(sen)) {
          throw unprocessable('unknown_sen', 'That does not look like a SEN.')
        }

        // Same rule as registration, so an admin cannot set a password weaker
        // than a self-registering attendee could choose.
        const problem = passwordProblem(password)
        if (problem) throw unprocessable('weak_password', problem)

        const { rows: found } = await db().query<{ id: string; name: string; sen: string }>(
          'select id, name, sen from attendees where upper(sen) = $1',
          [sen],
        )
        const attendee = found[0]

        // The admin already knows the roster, so this does not need to be an
        // enumeration oracle the way the old public endpoint's 404 was.
        if (!attendee) {
          throw unprocessable('unknown_sen', 'No registered attendee matches that SEN.')
        }

        const client = await db().connect()
        try {
          await client.query('begin')

          await client.query('update attendees set password_hash = $2 where id = $1', [
            attendee.id,
            await hashPassword(password),
          ])

          // Revoke every existing session. A password change that leaves old
          // sessions alive has not actually locked anyone out, which defeats
          // the point of changing a password at all. It also makes a takeover
          // visible: the previous holder is logged out and notices.
          await client.query(`delete from sessions where kind = 'attendee' and subject_id = $1`, [
            attendee.id,
          ])

          await client.query(
            'insert into password_changes (attendee_id, admin_id) values ($1, $2)',
            [attendee.id, adminId],
          )

          await client.query('commit')
        } catch (cause) {
          await client.query('rollback')
          throw cause
        } finally {
          client.release()
        }

        return json(res, 200, {
          attendee: { id: attendee.id, name: attendee.name, sen: attendee.sen },
          sessionsRevoked: true,
        })
      }

      /*
        The attendance log. Available to every staff account, `gate` included —
        "has this person already been through the door" is a gate question, not a
        management one.

        The attendee's NAME rides along on each row.

        It used to be resolved client-side against `GET /admin/attendees`, which
        is exactly the roster a volunteer must not have. Carrying one name per
        row is what the log displays anyway; making them fetch the whole roster
        to see it would have meant handing them the roster.
      */
      case 'GET /admin/attendance': {
        requireAdmin()
        const { rows } = await db().query(
          `select t.id,
                  t.sen,
                  t.attendee_id as "attendeeId",
                  t.at,
                  t.method,
                  t.day,
                  a.name as "attendeeName"
             from attendance t
             join attendees a on a.id = t.attendee_id
            order by t.day, t.at`,
        )
        /*
          `order by day, then at` rather than `at` alone. The log is read one day at
          a time — "who came on day one" is the question — and interleaving two
          days by clock time turns that into a scan for a needle.
        */
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

        /*
          The day comes from the server's calendar, never from the request.

          A `day` field in the body would let the client file a scan under any
          heading it liked, and a stale toggle in a stale tab would do exactly that
          to a whole queue without anybody noticing until the export was read. The
          operator's only job at the door is to scan the badge.
        */
        const dayState = await resolveEventDay()
        const day = dayState.activeDay

        /*
          A LOCKED day refuses new marks, before the insert and not after it.

          Checked here rather than by a constraint so the refusal can carry copy a
          volunteer can act on. The wording matters more than usual here, because the
          person holding the badge has done nothing wrong: the door is not broken,
          attendance for that day is simply closed. Saying "day 1 is locked, ask an
          organiser to reopen it" tells a volunteer what to do next; a bare
          `day_locked` code tells them nothing.

          Checked BEFORE the attendee lookup would change which error an unregistered
          SEN gets, so it stays after: an unknown SEN is still `unknown_sen` whoever
          the day is.
        */
        if (isDayLocked(dayState, day)) {
          throw conflict(
            'day_locked',
            `Attendance for day ${day} is closed. Ask an organiser to reopen it.`,
          )
        }

        /*
          ATOMIC, and on (attendee_id, day).

          The unique index is the real guard, so two scanners hitting the same
          badge at the same instant cannot both insert — a SELECT-then-INSERT
          would have a window here.

          The conflict is per day, which is the entire point: somebody marked on
          day one is still admitted on day two, because they came. That is what
          `on conflict do nothing` returning nothing now means — "already marked
          for THIS day" rather than "already marked, ever".
        */
        const { rows: inserted } = await db().query<{
          id: string
          sen: string
          // Must match the SQL alias below. Declaring the row as
          // `attendee_id` while the query aliases it to `attendeeId` compiles
          // cleanly and then reads `undefined` at runtime.
          attendeeId: string
          at: string
          method: string
          day: number
        }>(
          `insert into attendance (sen, attendee_id, method, day)
           select sen, id, $2, $3 from attendees where id = $1
           on conflict (attendee_id, day) do nothing
           returning id, sen, attendee_id as "attendeeId", at, method, day`,
          [attendee.id, admission, day],
        )

        const record = inserted[0]
        if (!record) {
          /*
            Nothing came back, and that has TWO causes which need different answers.

            The obvious one is the `(attendee_id, day)` conflict: already marked
            today. But the INSERT is `select … from attendees where id = $1`, so if
            the attendee row was deleted between the lookup above and this statement
            — by `remove-attendee.mjs`, or by a fixture purge — it also inserts
            nothing. Reading every empty result as a conflict told a volunteer that
            somebody who no longer exists was "already checked in", which is the one
            answer that should never be given about an unregistered SEN: it reads as
            proof they are on the list.

            One extra query, and only on the failure path, so the happy path is
            untouched.
          */
          const { rowCount: stillThere } = await db().query(
            'select 1 from attendees where id = $1',
            [attendee.id],
          )
          if (stillThere === 0) throw unprocessable('unknown_sen')

          throw conflict(
            'already_checked_in',
            day > 1 ? `Already marked for day ${day}.` : undefined,
          )
        }

        const { rows: person } = await db().query<AttendeeRow>(
          'select id, name, phone, sen, password_hash, created_at from attendees where id = $1',
          [record.attendeeId],
        )
        const attendeeRow = person[0]
        if (!attendeeRow) throw notFound()

        /*
          The day state rides along so the scan confirmation can say which day it
          just recorded. An operator confirming "day two, marked" at a busy door
          cannot infer it, and getting it wrong at the door is worse than being
          told.
        */
        return json(res, 201, {
          ...record,
          attendee: publicAttendee(attendeeRow),
          dayState: {
            activeDay: dayState.activeDay,
            totalDays: dayState.totalDays,
            overridden: dayState.overridden,
          },
        })
      }

      case 'PATCH /admin/event': {
        requireOwner()
        const body = await readJson<Record<string, unknown>>(req)

        /*
          `phase`, `dayOverride` and `lockedDays` are all optional and independent,
          so a panel can set one without clobbering the others.
        */
        let phase: 'registration' | 'live' | 'completed' | undefined
        if (body.phase !== undefined) {
          if (body.phase !== 'registration' && body.phase !== 'live' && body.phase !== 'completed') {
            throw badRequest('unknown', 'Invalid phase.')
          }
          phase = body.phase
        }

        let dayOverride: number | null | undefined
        if (body.dayOverride !== undefined) {
          if (body.dayOverride === null) {
            dayOverride = null
          } else {
            const requested = Number(body.dayOverride)
            if (!Number.isInteger(requested)) {
              throw badRequest('unknown', 'Invalid day.')
            }
            // `resolveEventDay` refuses an out-of-range override on read, so an
            // unvalidated write here would be silently ignored and the panel
            // would appear to have done nothing.
            const total = await eventTotalDays()
            if (requested < 1 || requested > total) {
              throw badRequest(
                'unknown',
                total === 1 ? 'This is a one-day event.' : `Choose a day between 1 and ${total}.`,
              )
            }
            dayOverride = requested
          }
        }

        let lockedDays: number[] | undefined
        if (body.lockedDays !== undefined) {
          if (!Array.isArray(body.lockedDays)) {
            throw badRequest('unknown', 'Invalid days.')
          }

          const total = await eventTotalDays()
          const requested = body.lockedDays.map((value) => Number(value))

          if (requested.some((day) => !Number.isInteger(day))) {
            throw badRequest('unknown', 'Invalid days.')
          }

          const outOfRange = requested.filter((day) => day < 1 || day > total)
          if (outOfRange.length > 0) {
            throw badRequest(
              'unknown',
              total === 1 ? 'This is a one-day event.' : `Choose a day between 1 and ${total}.`,
            )
          }

          // De-duplicated and sorted, so the stored row has one canonical shape
          // whatever order the client sent.
          lockedDays = [...new Set(requested)].sort((a, b) => a - b)
        }

        /*
          `registrationMode` is optional and independent of everything else here, so
          the switch can be flipped without disturbing the day, the locks or the
          phase — which is what the panel does, and what makes each control safe to
          retry on a bad connection.

          Resolved through the same validator the roster upload uses, so there is one
          definition of a valid mode rather than two that can drift. Rejected rather
          than coerced: this value decides who may register, and an unrecognised
          string must not be stored and then match nothing at the door.
        */
        const mode = readRegistrationMode(body.registrationMode)

        return sendEvent(res, phase, dayOverride, lockedDays, mode)
      }

      case 'GET /admin/agenda':
      case 'PATCH /admin/agenda': {
        requireAdmin()
        return sendEvent(res)
      }
    }

    // PATCH /admin/agenda/:id
    if (method === 'PATCH' && group === 'admin' && action === 'agenda' && rest[0]) {
      requireOwner()
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

/** The three things "who may register" can mean. */
const REGISTRATION_MODES = ['open', 'restricted', 'closed'] as const
type RegistrationMode = (typeof REGISTRATION_MODES)[number]

/**
 * Reads a requested registration mode, or returns null when the field is absent.
 *
 * Rejects an unrecognised value rather than coercing it. This string decides who
 * may register for the event; silently storing something that matches none of the
 * three checks at the door would leave a portal where nobody can register and
 * nothing says why.
 */
function readRegistrationMode(value: unknown): RegistrationMode | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && (REGISTRATION_MODES as readonly string[]).includes(value)) {
    return value as RegistrationMode
  }
  throw badRequest(
    'unknown',
    `Registration must be one of: ${REGISTRATION_MODES.join(', ')}.`,
  )
}

/* ----------------------------------------------------------------- helpers */

/**
 * Notes that an admin set somebody's password.
 *
 * Shared by the desk password change and by creating an attendee by hand, because
 * both are the same privileged act — somebody else's credential, chosen by an
 * operator, on their behalf. An account created out of band is the more sensitive of
 * the two, so it must not be the one without a trail.
 */
async function recordPasswordChange(adminId: string, attendeeId: string): Promise<void> {
  await db().query(
    'insert into password_changes (attendee_id, admin_id) values ($1, $2)',
    [attendeeId, adminId],
  )
}

/**
 * How many days the event spans, straight from the row.
 *
 * Computed in SQL rather than in JS, because this is the check that decides whether
 * a requested day is real. Deriving it in JavaScript means a second implementation
 * of the same rule — and the two already disagree once, in `eventDay.ts`, where
 * node-pg's DATE conversion made `totalDaysFor` silently answer 1 for a two-day
 * event. There is one place that turns a range into a number, and this is it.
 */
async function eventTotalDays(): Promise<number> {
  const { rows } = await db().query<{ n: number }>(
    `select greatest((coalesce(end_date, date) - date) + 1, 1)::int as n
       from events order by date desc limit 1`,
  )
  return rows[0]?.n ?? 1
}

async function sendEvent(
  res: VercelResponse,
  phase?: 'registration' | 'live' | 'completed',
  dayOverride?: number | null,
  lockedDays?: number[],
  registrationMode?: RegistrationMode | null,
): Promise<void> {
  if (phase) {
    await db().query('update events set phase = $1 where id = $2', [
      phase,
      'evt_awakening_2026',
    ])
  }

  if (dayOverride !== undefined) {
    await db().query('update events set day_override = $1 where id = $2', [
      dayOverride,
      'evt_awakening_2026',
    ])
  }

  if (lockedDays !== undefined) {
    await db().query('update events set locked_days = $1 where id = $2', [
      lockedDays,
      'evt_awakening_2026',
    ])
  }

  if (registrationMode !== undefined && registrationMode !== null) {
    await db().query('update events set registration_mode = $1 where id = $2', [
      registrationMode,
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
            venue, city, phase, capacity, day_override,
            registration_mode,
            (select count(*) from event_roster)::int as roster_count
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
        day_override: number | null
        registration_mode: string | null
        roster_count: number | null
      }
    | undefined

  if (!event) throw notFound('No event configured.')

  const dayState = await resolveEventDay()

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
    /*
      The day state travels with the event rather than on its own endpoint.

      It is event data — when the event is, in effect — and the dashboard, the
      admin masthead and the Programme panel all need it. Putting it on `/event`
      means one request serves all three, and there is no way for two parts of the
      UI to disagree about which day it is.

      `totalDays` from the row rather than from the agenda, so a programme that
      happens to list only day-one sessions still reports a two-day event.
    */
    activeDay: dayState.activeDay,
    calendarDay: dayState.calendarDay,
    totalDays: dayState.totalDays,
    dayOverride: event.day_override ?? null,
    dayOverridden: dayState.overridden,
    // From `resolveEventDay`, not the raw column: that already dropped any day the
    // event no longer has. The UI must not render a lock against a day that does
    // not exist.
    lockedDays: dayState.lockedDays,
    /*
      Public, and deliberately.

      The registration form has to be able to say "registration is closed" BEFORE
      somebody fills it in, rather than letting them type four fields and then
      refusing. That is not a secret — it is printed on the door — and the mode is
      the only part of the event payload that changes what a visitor is offered.
    */
    registrationMode: event.registration_mode ?? 'open',
    rosterCount: Number(event.roster_count ?? 0),
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
