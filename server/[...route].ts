import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db } from './_lib/db.ts'
import {
  createSession,
  currentSession,
  destroySession,
  purgeExpiredSessions,
  verifyPassword,
} from './_lib/auth.ts'
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  json,
  notFound,
  readJson,
  requireString,
  unauthorized,
  unprocessable,
} from './_lib/http.ts'
import {
  isValidSen,
  nameProblem,
  normalisePhone,
  normaliseSen,
  phoneProblem,
} from './_lib/identifiers.ts'
import { emailProblem, normaliseEmail } from './_lib/email.ts'
import { resolveEventDay, isDayLocked } from './_lib/eventDay.ts'
/*
  Still needed, and only for the gate.

  No pass is issued any more — there are no accounts — so `readTicket` will never
  see a signature again and always takes its bare-SEN fallback. That is exactly
  what the admin attendance route needs: a volunteer at the door typing a SEN
  somebody cannot scan for, which is the whole reason that route still exists.
*/
import { readTicket } from './_lib/ticket.ts'
// Only the reset-attempt ledger purge survives; the limiter itself went with the
// endpoint it protected. See `_lib/reset.ts`.
import { purgeOldResetAttempts } from './_lib/reset.ts'
import { latestAnnouncement, pushConfigured, vapidPublicKey } from './_lib/push.ts'
import { teamPassHtml, teamPassSubject, teamPassText } from './_lib/teamPass.ts'
import { mailConfigured, sendMail } from './_lib/mail.ts'

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
  email: string | null
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

export type EmailOutcome = 'sent' | 'not_set' | 'failed' | 'no_address'

/**
 * How many people are on a team, leader included.
 *
 * One constant, read by the route that validates, the tests, and the copy on both
 * surfaces. It was a number in a form, a number in a check and a number in an
 * email at three different times.
 */
const TEAM_SIZE = 3

/**
 * Is the event shut to everybody?
 *
 * ONE SWITCH FOR BOTH DOORS, because an organiser closing registration at the end
 * of a day means both things at once: no more teams may be created, and no more
 * attendance may be recorded. They are the same decision, and making them two would
 * mean the one that was forgotten is the one that lets people in.
 *
 * THE COLUMN ALREADY EXISTED AND DID NOTHING. `events.registration_mode` has carried
 * `'open' | 'restricted' | 'closed'` since the guest list was removed, the server
 * returned it in `/event`, and the client's `EventInfo` declared it. No public route
 * read it and no admin control wrote it — a field that is persisted, transmitted and
 * typed, and enforces nothing. Half of a feature is worse than none of it, because
 * it reads on a screen as though it were working.
 *
 * `'restricted'` means the guest list is being enforced and is NOT shut. Only
 * `'closed'` stops anything, so a team running with a restricted list is unaffected.
 *
 * Read once per request and passed in, never cached on the module: an organiser
 * pressing the switch expects the next request to be refused, and a cached answer
 * would keep the door open for the life of a warm lambda.
 */
async function registrationIsClosed(): Promise<boolean> {
  const { rows } = await db().query<{ registration_mode: string | null }>(
    'select registration_mode from events order by date desc limit 1',
  )
  return rows[0]?.registration_mode === 'closed'
}


/**
 * A team, as the API hands it over.
 *
 * The database column names are renamed here, once, rather than at every read.
 * `is_leader` becoming `isLeader` in SQL via `json_build_object` gets the member
 * objects right but leaves `leader_name` snake_case beside them, so the shape had
 * to be assembled anyway — and one place that assembles it cannot be got wrong
 * differently in two places.
 */
interface TeamRow {
  readonly id: string
  readonly name: string
  readonly leaderName: string
  readonly leaderEmail: string
  readonly leaderPhone: string
  readonly createdAt: string
  readonly passSentAt: string | null
  readonly members: readonly { name: string; sen: string; isLeader: boolean }[]
}

/**
 * Every team with its members, newest first.
 *
 * THE MEMBERS ARE JOINED HERE AND NOWHERE ELSE. An organiser watching a queue
 * fill up reads this several times a minute, and assembling three members per
 * team in the client would be three chances to render a team with two.
 *
 * The `filter (where m.id is not null)` is what makes the LEFT JOIN safe: without
 * it a team with no members yet aggregates to `[{"name": null}]` rather than to an
 * empty list, and a half-registered team would show a blank member.
 *
 * Leader first, then by join order, so the pass and the admin list agree on who
 * row one is without either of them sorting.
 */
async function listTeams(): Promise<TeamRow[]> {
  const { rows } = await db().query<{
    id: string
    name: string
    leader_name: string
    leader_email: string
    leader_phone: string
    created_at: string
    pass_sent_at: string | null
    members: { name: string; sen: string; isLeader: boolean }[]
  }>(`
    select t.id, t.name, t.leader_name, t.leader_email, t.leader_phone,
           t.created_at, t.pass_sent_at,
           coalesce(
             json_agg(
               json_build_object(
                 'name', m.name, 'sen', m.sen, 'isLeader', m.is_leader
               ) order by m.is_leader desc, m.created_at
             ) filter (where m.id is not null),
             '[]'::json
           ) as members
      from teams t
      left join team_members m on m.team_id = t.id
     group by t.id
     order by t.created_at desc`)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    leaderName: row.leader_name,
    leaderEmail: row.leader_email,
    leaderPhone: row.leader_phone,
    createdAt: row.created_at,
    passSentAt: row.pass_sent_at,
    members: row.members,
  }))
}

/**
 * Did the database refuse this because something was already there?
 *
 * Used only for the team member SEN, which has a unique index across the whole
 * table. The distinction matters: "that SEN is on another team" is an answer the
 * leader can act on, and reporting it as an internal fault would leave them
 * guessing.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
}

const ADMIN_ROLES = ['owner', 'gate'] as const
type AdminRole = (typeof ADMIN_ROLES)[number]

function adminRole(value: unknown): AdminRole {
  return value === 'gate' ? 'gate' : ADMIN_ROLES.includes(value as AdminRole) ? 'owner' : 'gate'
}

async function route(
  req: VercelRequest,
  res: VercelResponse,
  method: string,
  path: string[],
): Promise<void> {
  /*
    `action` and `rest` are no longer destructured.

    They existed for `GET /teams` and `PATCH /admin/agenda/:id`, both of which are
    gone. Left in place they read as though those routes might still come back, and
    an unused destructuring is one more thing to grep past when auditing.
  */
  const [group] = path
  const key = `${method} /${path.join('/')}`

  /* -- public programme data -------------------------------------------- */
  if (key === 'GET /event') {
    return sendEvent(res)
  }

  /*
    The VAPID public key.

    Unauthenticated, and outside the attendee block because it genuinely is public:
    the point is to know whether push is available BEFORE anybody logs in. The client
    needs the key to build a subscription, and a deployment without one should show no
    toggle rather than offer a button that fails when pressed.

    The key is public by design. It is an address, not a credential — it lets a
    browser say "send to me here" and does nothing else. The private key is what makes
    a send possible, and it never leaves the server.
  */
  if (key === 'GET /push/key') {
    return json(res, 200, {
      configured: pushConfigured(),
      publicKey: vapidPublicKey(),
    })
  }

  /*
    There is no GET /teams.

    There was one, and it served four invented teams to anyone who asked, with no
    session required. Removing the route and the table together matters: leaving
    the route would 500 against the dropped table, which during an event looks
    like the portal is broken rather than like a feature that was removed on
    purpose.
  */

  /*
    TEAMS.

    Its OWN group rather than a case inside the attendee one. The dispatcher
    reads the first path segment, so `/team/register` never reaches an
    `attendee` block however similar the two forms are — and a case written there
    is a 404 to a route that is plainly present in the file, which is the worst
    kind of bug to find on event day.

    No session, no lock, no gate. A team registers whenever it is ready.
  */
  if (group === 'team') {
    switch (key) {
        case 'POST /team/register': {
          const body = await readJson<Record<string, unknown>>(req)
  
          const name = requireString(body, 'name').trim()
          const leaderName = requireString(body, 'leaderName').trim()
          const leaderEmail = normaliseEmail(requireString(body, 'leaderEmail'))
          const leaderPhone = normalisePhone(requireString(body, 'leaderPhone'))
  
          const leaderNameProblem = nameProblem(leaderName)
          if (leaderNameProblem !== null) throw unprocessable('unknown', leaderNameProblem)
  
          const nameProblemMessage = nameProblem(name)
          if (nameProblemMessage !== null) throw unprocessable('unknown', nameProblemMessage)
  
          const phoneProblemMessage = phoneProblem(leaderPhone)
          if (phoneProblemMessage !== null) throw unprocessable('unknown', phoneProblemMessage)
  
          const emailProblemMessage = emailProblem(leaderEmail)
          if (emailProblemMessage !== null) throw unprocessable('unknown', emailProblemMessage)
  
          /*
            Two teammates, exactly. Not "however many were supplied": a body with one
            or four is a client that disagrees with the form about the shape of a
            team, and accepting it would put a two-person team on the leader's pass
            with three names' worth of promise.
          */
          const mates = Array.isArray(body.members) ? body.members : []
          if (mates.length !== TEAM_SIZE - 1) {
            throw unprocessable('unknown', `A team has ${TEAM_SIZE} members.`)
          }
  
          const parsedMates = mates.map((raw, index) => {
            const member = (raw ?? {}) as Record<string, unknown>
            const memberName = String(member.name ?? '').trim()
            const memberSen = normaliseSen(String(member.sen ?? ''))
  
            const memberNameProblem = nameProblem(memberName)
            if (memberNameProblem !== null) {
              throw unprocessable('unknown', `Member ${index + 2}: ${memberNameProblem}`)
            }
            if (!isValidSen(memberSen)) {
              throw unprocessable(
                'unknown',
                `Member ${index + 2}: enter a valid SEN, e.g. A866175000012.`,
              )
            }
            return { name: memberName, sen: memberSen }
          })
  
          // The leader is a member too, with their own SEN.
          const leaderSen = normaliseSen(requireString(body, 'leaderSen'))
  
          /*
            All three SENs are distinct WITHIN the team, checked before anything is
            written rather than relying on the unique index to fail the third insert
            and leave the first two behind.
          */
          const sens = [leaderSen, ...parsedMates.map((m) => m.sen)]
          if (new Set(sens.map((s) => s.toUpperCase())).size !== TEAM_SIZE) {
            throw unprocessable('unknown', 'Each member of a team needs a different SEN.')
          }
  
          /*
            ALREADY ON A TEAM — and ONLY that.

            This query used to UNION the check-in register in as well, so a student
            who had checked in for day one could not lead a team, and was told
            "Already registered: <their own SEN>" for a SEN that appeared on no team
            at all. Every attendee of this event is a candidate to lead one, so that
            check made the feature unusable for exactly the people it is for.

            Attendance and team membership are separate records about a person for
            separate reasons. Somebody attends on their own SEN every day and leads
            a team once. Nothing about the first has any bearing on the second.

            So the scope is `team_members` alone. A SEN may still only be on one
            team, which is the rule that actually matters: it stops a person being
            listed twice on two leaders' passes and two teams claiming the same
            student.
          */
          const onATeam = await db().query<{ sen: string }>(
            'select sen from team_members where upper(sen) = any($1::text[])',
            [sens],
          )
          if (onATeam.rows.length > 0) {
            const taken = onATeam.rows.map((r) => r.sen).join(', ')
            throw conflict(
              'sen_taken',
              `Already on a team: ${taken}. Each student can be on one team only.`,
            )
          }
  
          /*
            Deliberately NOT gated on the day lock.
  
            A team may register for tomorrow's brief on the evening of day one.
            Closing day one's attendance must not close the challenge registration
            with it — those are two different decisions and the lock exists for one
            of them.

            It IS gated on the whole-event switch, because closing the event shuts
            every door at once. A leader who registers after an organiser has closed
            it has been told something that is no longer true.
          */

          if (await registrationIsClosed()) {
            throw conflict(
              'registration_closed',
              'Team registration is closed. Speak to an organiser.',
            )
          }

          const client = await db().connect()
          try {
            await client.query('begin')
  
            const created = await client.query<{ id: string }>(
              `insert into teams (name, leader_name, leader_email, leader_phone)
               values ($1, $2, $3, $4)
               returning id`,
              [name, leaderName, leaderEmail, leaderPhone],
            )
            const teamId = created.rows[0].id
  
            const rows = [
              { name: leaderName, sen: leaderSen, is_leader: true },
              ...parsedMates.map((m) => ({ ...m, is_leader: false })),
            ]
  
            try {
              /*
                One statement for all three rows, not three inserts.

                `unnest` with an explicit column alias — without `as m(name, sen,
                is_leader)` Postgres cannot resolve the bare column names in the
                SELECT list and answers 42703, which is not a message anybody
                wants to read at 9am on the day.
              */
              await client.query(
                `insert into team_members (team_id, name, sen, is_leader)
                 select $1, m.name, m.sen, m.is_leader
                   from unnest($2::text[], $3::text[], $4::boolean[])
                     as m(name, sen, is_leader)`,
                [teamId, rows.map((r) => r.name), rows.map((r) => r.sen), rows.map((r) => r.is_leader)],
              )
            } catch (error) {
              /*
                A SEN on another team, raced between the check above and this insert.
                Reported as the conflict it is rather than as a fault, because "that
                student is already on a team" is the one thing the leader needs to know.
              */
              if (isUniqueViolation(error)) {
                throw conflict('sen_taken', 'One of those SENs is already on another team.')
              }
              throw error
            }
  
            await client.query('commit')
  
            /*
              The response is assembled here rather than being the row objects.

              `rows` carries `is_leader` because that is the column; the client
              contract says `isLeader`. Sending the database shape out means the
              confirmation renders "undefined" against every leader's name and the
              type says nothing, because the type is on the client and the value is
              from the server. One mapping, here, is where that stops.

              Leader first, matching the insert order, so the list on the
              confirmation reads top-down in the order it was typed.
            */
            return json(res, 201, {
              ok: true,
              team: { id: teamId, name, leaderName, leaderEmail, leaderPhone },
              members: rows.map((r) => ({ name: r.name, sen: r.sen, isLeader: r.is_leader })),
            })
          } catch (error) {
            await client.query('rollback').catch(() => {})
            throw error
          } finally {
            client.release()
          }
        }
    }
  }

  /* -- attendee --------------------------------------------------------- */
  if (group === 'attendee') {
    /*
      No session, and none is needed.

      There is nothing to hold a session FOR. An account needs one to prove whose
      attendance it is asking about; a check-in has nothing to prove, and the answer
      comes back in the body.

      The old code ran 'currentSession' on every request in this group whether or not
      a route used it, and every route that did use it is gone.
    */
    switch (key) {
      /*
        CHECK IN. This is the whole attendee side.

        A name, a phone and a SEN, and the day is recorded. No account, no password,
        no session, no pass.

        THE DAY IS RESOLVED SERVER-SIDE, NEVER FROM THE BODY. A 'day' field would let
        a stale page file a whole queue under any heading it liked, and the export
        would be the only place that ever showed it.

        A LOCKED DAY REFUSES BEFORE ANY WRITE, so closing attendance is instant and
        total rather than "from the next request onwards". Checked before the lookup
        because when an organiser closes a day they mean it — including for somebody
        already at the box with the form open, whose only correct answer is "it is
        closed" rather than a database error about a SEN that is not on file.
      */
      case 'POST /attendee/checkin': {
        const body = await readJson<Record<string, unknown>>(req)

        const name = requireString(body, 'name').trim()
        const phone = normalisePhone(requireString(body, 'phone'))
        const sen = normaliseSen(requireString(body, 'sen'))

        const phoneProblemMessage = phoneProblem(phone)
        if (phoneProblemMessage !== null) throw unprocessable('unknown', phoneProblemMessage)

        const nameProblemMessage = nameProblem(name)
        if (nameProblemMessage !== null) throw unprocessable('unknown', nameProblemMessage)

        if (!isValidSen(sen)) {
          throw unprocessable('unknown', 'Enter a valid SEN, e.g. A866175000012.')
        }

        const dayState = await resolveEventDay()
        const day = dayState.activeDay

        /*
          The whole event being shut is checked before the day, and before the
          lookup.

          Order matters: a student who arrives after the event is closed should be
          told the event is closed, not that day one is locked. They are at the door
          for the first time and have no idea which day it is, and "day 1 is locked"
          sends them looking for an organiser instead of at the door.

          Checked before any write, for the same reason the day lock is: closing
          must be instant and total rather than "from the next request onwards".
        */
        if (await registrationIsClosed()) {
          throw conflict(
            'registration_closed',
            'Registration and attendance are both closed. Speak to an organiser.',
          )
        }

        if (isDayLocked(dayState, day)) {
          throw conflict(
            'day_locked',
            'Attendance for day ' + day + ' is closed. Ask an organiser to reopen it.',
          )
        }

        /*
          One row per person, created on the first check-in.

          The SEN is the only identifier here — there is no password to check against
          — so it is the natural key and it carries the unique constraint.

          On a phone collision the SEN wins. Two students sharing a household number
          is a real thing, and refusing the second would be a rule about a field
          nothing downstream depends on: the door and the export both read the SEN.

          AND THAT IS WHY THE PHONE IS NOT UNIQUE ANY MORE.

          It used to be, because login took a phone number. Two students sharing a
          household number is a real thing, and the old constraint refused the second
          of them — over a column that indexed an identifier nothing reads now.

          Left in place it was worse than useless. The check-in insert has no handler
          for the violation, so a shared number produced a 500: a fault in the portal,
          reported to a student standing at a wall, for something entirely ordinary.
          Two students living together is not an attack, and refusing the second one
          would lock out a real person over a field nothing depends on.
        */
        const existing = await db().query<{ id: string; name: string }>(
          'select id, name from attendees where sen = $1',
          [sen],
        )

        let attendeeId = existing.rows[0]?.id
        const recordedName = existing.rows[0]?.name ?? name

        /*
          Whether this request is the one that created the person.

          Decided by the INSERT, not by the SELECT above. The two disagree under
          concurrency: twenty taps for a brand new SEN all read "no such person"
          before any of them wrote, so every one of them concluded it was the first
          — and nineteen of them were wrong. The INSERT is the authority, because
          only it knows which of the twenty actually inserted the row.

          The flag is now false whenever the mark did not land either, so the pair
          can no longer say `firstTime: true, alreadyMarked: true` at the same time.
        */
        let firstTime = existing.rows.length === 0

        if (attendeeId === undefined) {
          const created = await db().query<{ id: string; inserted: boolean }>(
            /*
              `xmax = 0` tells an INSERT from an UPDATE.

              Without it, this statement cannot say which of the two happened — and
              the two mean different things to the person in front of the portal.
              Twenty simultaneous taps for a brand new SEN all read "no such person"
              in the SELECT above, all reached this statement, one inserted and
              nineteen took the conflict branch, and every one of them answered
              `firstTime: true`. The register was right. The answers were not.

              `xmax` is zero on a freshly inserted tuple and holds a transaction id
              on a row an UPDATE just rewrote, which is the only way to tell them
              apart inside the statement itself.
            */
            `insert into attendees (name, phone, sen, email, password_hash)
             values ($1, $2, $3, null, null)
             on conflict (sen) do update set name = excluded.name
             returning id, (xmax = 0) as inserted`,
            [name, phone, sen],
          )
          attendeeId = created.rows[0].id
          firstTime = created.rows[0].inserted
        }

        if (attendeeId === undefined) {
          throw unprocessable('unknown', 'Could not record that check-in. Try again.')
        }

        /*
          The mark itself, on the same unique index the gate uses.

          'do nothing' returning nothing means "already marked for THIS day", and the
          response says so rather than pretending a second mark landed. Somebody who
          taps twice, or whose first tap timed out on a weak signal and who retried,
          gets the same answer either way — which is right, because both times they
          did attend.

          'method' is 'self' rather than 'qr', so a day taken entirely by self
          check-in is visibly a different kind of day from one the gate scanned.
        */
        const marked = await db().query<{ id: string; at: string }>(
          "insert into attendance (sen, attendee_id, method, day) values ($1, $2, 'self', $3) on conflict (attendee_id, day) do nothing returning id, at",
          [sen, attendeeId, day],
        )

        const alreadyMarked = marked.rows.length === 0

        return json(res, alreadyMarked ? 200 : 201, {
          ok: true,
          alreadyMarked,
          /*
            Two INDEPENDENT facts, and they are allowed to both be true.

            `alreadyMarked` says the attendance row was already there.
            `firstTime` says THIS REQUEST created the person in the register.

            An intermediate version tied them together with `&& !alreadyMarked`, on
            the reasoning that the two contradicting each other would be a bug. Under
            a burst of twenty taps it made twenty responses say `firstTime: false`,
            including the one that genuinely created the person — because the two
            races are independent and the request that wins the attendee INSERT does
            not necessarily win the attendance INSERT. "First time" and "already
            marked" are not opposites: the first arrival can lose a race it still
            won, and the loser can be the one whose mark lands.

            The confirmation reads `alreadyMarked` and never this, so nothing on
            screen depends on the pairing.
          */
          firstTime,
          name: recordedName,
          sen,
          day,
          at: marked.rows[0]?.at ?? null,
          dayState: {
            activeDay: dayState.activeDay,
            totalDays: dayState.totalDays,
            overridden: dayState.overridden,
          },
        })
      }

      /*
        Which days is this SEN marked for.

        No session, so the caller names the SEN. That is a lookup rather than a
        disclosure: a student already knows their own SEN, and a SEN that has never
        been marked returns nothing at all, so the route cannot be used to find out
        who is coming.

        This exists for the awkward case. Somebody who tapped once on a bad connection
        has no way to tell whether it landed, and with no account there is nowhere
        else for them to look.
      */
      case 'GET /attendee/attendance': {
        const requested = new URL(req.url ?? '', 'http://localhost').searchParams.get('sen')
        const sen = requested === null ? '' : normaliseSen(requested)
        if (!isValidSen(sen)) return json(res, 200, { records: [] })

        const { rows } = await db().query(
          'select id, sen, attendee_id as "attendeeId", at, method, day from attendance where upper(sen) = upper($1) order by day',
          [sen],
        )

        return json(res, 200, { records: rows })
      }
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

    /*
          EVERY TEAM, newest first, with their members.

          OWNER ONLY, and not because the data is secret — it is names, SENs and one
          email address each. It is owner-only because emailing every leader at once
          is a power that reaches outside the room, and that belongs to whoever runs
          the event rather than to whoever is on the door. `gate` marks people
          present; it does not correspond with people.

          The members arrive JOINED, never assembled per team by the client. An
          organiser watching a queue fill up reads this list several times a minute,
          and three round trips to render one row is three chances to show a team
          with two members.
        */
      case 'GET /admin/teams': {
        requireOwner()
        return json(res, 200, { teams: await listTeams() })
      }

      /*
        Email the pass to EVERY LEADER.

        SEQUENTIALLY, and never in parallel. One Resend request at a time: a burst
        of twenty at once is what gets a sending domain rate-limited, and the result
        would be a partial send that reported itself as a failure with no way to
        tell which half landed.

        EVERY FAILURE IS REPORTED AND NONE IS RETRIED. A refused address is not
        going to become deliverable, and the organiser is shown which teams still
        need a pass so they can send one by hand.

        `pass_sent_at` is stamped per team on success, so the button does not
        silently re-send to somebody who already has one, and the list shows at a
        glance who has.
      */
      case 'POST /admin/teams/email': {
          requireOwner()

          const rows = await listTeams()

          const sent: string[] = []
          const failures: { team: string; leader: string; reason: string }[] = []

          for (const team of rows) {
            const pass = {
              name: team.name,
              leaderName: team.leaderName,
              leaderEmail: team.leaderEmail,
              leaderPhone: team.leaderPhone,
              members: team.members,
            }

            const outcome = await sendMail({
              to: pass.leaderEmail,
              subject: teamPassSubject(pass),
              text: teamPassText(pass),
              html: teamPassHtml(pass),
            })

            if (outcome.ok) {
              await db().query('update teams set pass_sent_at = now() where id = $1', [
                team.id,
              ])
              sent.push(team.name)
            } else {
              failures.push({
                team: team.name,
                leader: team.leaderName,
                reason: outcome.error ?? 'The mail service refused it.',
              })
            }
          }

          return json(res, 200, {
            configured: mailConfigured(),
            total: rows.length,
            sent: sent.length,
            failures,
            message:
              failures.length === 0
                ? `${sent.length} pass${sent.length === 1 ? '' : 'es'} emailed to the leaders.`
                : `${sent.length} sent, ${failures.length} could not be delivered.`,
          })
        }

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
      /*
        The whole guest list, so the names can actually be checked.

        `GET /admin/roster` deliberately returns a count and a sample of eight. That
        is the right default — the panel header wants to know whether anything landed,
        not to hold five hundred students in memory to say "yes, 500" — but it left an
        organiser unable to do the one thing they uploaded a list to do, which is look
        at it. Seeing that every row parsed correctly is how you find the row where a
        column shifted, before you enforce the list and lock somebody out.

        So this is a separate route, owner-only, fetched only when the panel's
        "check the names" control is opened, rather than a bigger default response.

        Owner-only is not incidental and not a formality: the full list is every
        student's name and SEN in one response, which is precisely what a `gate`
        account must never receive. `requireOwner()` runs before the query, so the
        rows are never read for an account that may not have them.

        Capped, and the cap is reported rather than applied silently. Truncating a
        check would produce "I looked at every name and they are all correct" for the
        rows that happened to be returned, which is worse than not offering the check
        at all. `total` is the true count and `truncated` says whether the cap was
        hit, so the panel can state it.
      */


      /*
        The guest list: who is allowed to register.

        Owner-only, and read-only in the sense that matters — it returns a COUNT and
        a SAMPLE, not the whole list. The full roster is every student's name and
        SEN, which is exactly the data a `gate` account must never receive, and an
        owner who needs to see the lot can download the sheet they uploaded. There
        is no route that returns all of it.
      */

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

      /*
        Broadcast to every opted-in device.

        Owner-only, not staff. `gate` exists to mark people present at a door, and a
        message to the whole event is a different power entirely: it reaches every
        registered attendee on their own phone, and the shared gate credential is
        exactly the one that must never be able to do that.

        The response reports what actually happened rather than "sent". On the day
        that distinction is the whole feature — "12 of 300 failed" is a warning worth
        acting on, and "sent" would have hidden it.
      */


      case 'GET /admin/agenda': {
        requireAdmin()
        return sendEvent(res)
      }

      /*
        Send everybody their credentials, one email each.

        OWNER ONLY, and the asymmetry with `gate` matters: a broadcast reaches every
        attendee on their own phone, and so does this. `gate` marks people present
        at a door; handing over credentials is not a door-side job.

        It generates a NEW password rather than resending the old one, because the
        old one cannot be resent — only a bcrypt hash is stored, and that is not
        reversible. So this is a rotation, and it is honest about being one: every
        password it issues invalidates the previous one.

        THE ROLLBACK IS THE WHOLE POINT. For each person in turn: generate, store,
        send. If the send fails, the previous hash is written back and they keep the
        password they had. Without that, one bounced mailbox would leave somebody
        locked out of their own pass with a password nobody knows — which during a
        live event is the difference between a person walking in and a person being
        turned away at the door.

        Sequential, not parallel. This is an owner clicking a button a few times a
        day, not a registration path, and a burst of 480 simultaneous requests to a
        mail provider is how an account gets rate-limited at exactly the wrong moment.

        The report is the deliverable. `skipped` carries the SENs with no address on
        file, so the owner knows precisely who to chase rather than discovering it
        from a person who could not log in.
      */
    }

    /*
      There is no PATCH /admin/agenda/:id.

      It existed so an owner could mark a session done / live / upcoming against
      a timetable. There is no timetable, so the flag described nothing, and an
      unattended event would have shown every attendee a permanent "upcoming"
      badge. Removing the route and the control together means neither the
      button nor a way to re-enable it survives.
    */
  }

  throw notFound('No such endpoint.')
}
/** The three things "who may register" can mean. */
const REGISTRATION_MODES = ['open', 'restricted', 'closed'] as const
type RegistrationMode = (typeof REGISTRATION_MODES)[number]

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
    `select id, day, starts_at, title, speaker, room
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
    /*
      The newest announcement, so the dashboard can show it on arrival.

      This is the half of broadcast that does not need permission. Push is refused by
      a meaningful share of browsers — declined, dismissed, or on a device that cannot
      do it — and without this those people would be told nothing at all, with no way
      for the owner to notice that they had been. Carried here rather than on its own
      endpoint because it is event-wide, public, and costs nothing on the poll that is
      already running.

      One, not a feed. This is a fallback for somebody who missed a push, not a
      message centre: the useful answer to "did they hear about the room change" is
      the current state of the world, not the history of it.
    */
    announcement: await latestAnnouncement(),
    agenda: agenda.map((item: Record<string, unknown>) => ({
      id: item.id,
      day: item.day,
      startsAt: item.starts_at,
      title: item.title,
      speaker: item.speaker,
      room: item.room,
    })),
  })
}
