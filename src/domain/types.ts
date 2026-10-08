/**
 * Domain model for the GDG event portal.
 *
 * Split into three concerns so each can be reasoned about on its own:
 *   - Identity  : who is attending
 *   - Access    : session + authorisation (admin is a separate door)
 *   - Programme : the event itself, teams and agenda
 *
 * Everything here is plain data. The real dataset you supply later should
 * satisfy these shapes; see `src/api/dataset.ts` for the swap point.
 */

/* ------------------------------------------------------------------ identity */

/**
 * Attendees are identified by name + phone, not email. Phone is the
 * quasi-unique key: normalised to ten digits, stored without a country code.
 */
export interface Attendee {
  readonly id: string
  readonly name: string
  readonly phone: string
  /**
   * Student Enrolment Number — carried by the attendee's barcode, and the
   * only value attendance is ever recorded against.
   */
  readonly sen: string
  readonly createdAt: string
}

export interface AttendeeWithSecret extends Attendee {
  readonly passwordHash: string
  /** Opaque ticket payload handed out at registration and encoded in the QR. */
  readonly ticketCode: string
}

/* -------------------------------------------------------------------- access */

export interface AttendeeSession {
  readonly attendee: Attendee
}

/**
 * Staff access levels.
 *
 * `owner` runs the event — the roster, credentials, the programme. `gate` is
 * whoever is on the door: mark attendance, read the log, read teams.
 *
 * Mirrors the server's list. It is here so the UI can hide what a `gate` account
 * cannot use — never to decide whether it is allowed. The server checks the role
 * on every route, because this value arrives in a cookie.
 */
export const ADMIN_ROLES = ['owner', 'gate'] as const

export type AdminRole = (typeof ADMIN_ROLES)[number]

/** Admins are entirely separate from attendees — separate login, separate session. */
export interface AdminUser {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly role: AdminRole
}

export interface AdminSession {
  readonly admin: AdminUser
}

export interface AttendeeLoginInput {
  readonly name: string
  readonly phone: string
  readonly password: string
  readonly remember: boolean
}

export interface AttendeeRegisterInput extends AttendeeLoginInput {
  /** Student Enrolment Number — the identity their barcode carries. */
  readonly sen: string
}

export interface AdminLoginInput {
  readonly username: string
  readonly password: string
}

/* ----------------------------------------------------------------- programme */

export type EventPhase = 'registration' | 'live' | 'completed'

export interface AgendaItem {
  readonly id: string
  /** Which day of the event this session runs on. 1-based. */
  readonly day: number
  readonly startsAt: string
  readonly title: string
  readonly speaker: string
  readonly room: string
  readonly status: 'done' | 'live' | 'upcoming'
}

export interface EventInfo {
  readonly id: string
  readonly name: string
  /** Sub-line under the title, e.g. "Built by you". */
  readonly tagline: string
  /** Who is running it, e.g. "Google Developer Groups". */
  readonly organiser: string
  /**
   * The institution hosting the event, when that is not the organiser — e.g.
   * "Amity University Bengaluru". Kept separate because both appear on the
   * attendee dashboard and conflating them reads as a single organisation.
   */
  readonly organiserHost?: string
  /** Day one, `YYYY-MM-DD`. */
  readonly date: string
  /**
   * Final day, `YYYY-MM-DD`. Present only for multi-day events; equal to
   * `date` for a single-day one, which is left as absent so the UI can say
   * "14 October" rather than a redundant "14 October".
   */
  readonly endDate?: string
  readonly venue: string
  readonly city: string
  readonly phase: EventPhase
  readonly capacity: number
  /**
   * Which day attendance scans are recorded against, resolved from the calendar
   * on the server.
   *
   * On `EventInfo` so every surface that needs to say "day one" agrees: the
   * attendee dashboard, the admin masthead and the Programme panel all read the
   * same value from the same response.
   */
  readonly activeDay: number
  /**
   * The day the calendar says it is, even when an override is in force.
   *
   * Shown beside the override control so the two can be compared. "The calendar
   * says day one, you pinned day two" is a sentence an owner can act on; the
   * portal quietly disagreeing with the date is not.
   */
  readonly calendarDay: number
  /** How many days the event runs for. 1 for a single-day event. */
  readonly totalDays: number
  /**
   * An owner has pinned the day with `dayOverride`.
   *
   * Surfaced so the UI can say so. A portal that thinks it is day one when the
   * calendar says day two is confusing exactly when it matters most, and the
   * override is the usual reason.
   */
  readonly dayOverridden: boolean
  /** The pinned day, or `null` to follow the calendar. Owner-only to set. */
  readonly dayOverride: number | null
  /**
   * Days attendance is closed for.
   *
   * Distinct from `dayOverride`: that moves the present forward, this closes a day
   * behind you. Exists because attendance is append-only with no edit and no
   * delete, so once a day's SEN list is gone for certificates there is no way to
   * correct a late scan — the only honest option is to stop accepting them.
   *
   * Read-only surfaces are unaffected: the log and the export still show a locked
   * day in full. This stops marks being written, it does not hide the record of
   * who attended.
   */
  readonly lockedDays: readonly number[]
  readonly agenda: readonly AgendaItem[]
}

/**
 * A team, as shown in the admin portal only: name, lead, members.
 * Deliberately minimal — the attendee dashboard does not surface teams.
 */
export interface Team {
  readonly id: string
  readonly name: string
  readonly leadName: string
  readonly members: readonly string[]
}

export interface TeamMember {
  readonly name: string
  readonly role: 'Lead' | 'Member'
}

/* ------------------------------------------------------------------- checkin */

/**
 * An attendance record.
 *
 * APPEND-ONLY. There is deliberately no update or delete anywhere in the API
 * or the UI — a record exists only because a barcode was scanned, and
 * correcting a mistake is done by a fresh scan after voiding out of band.
 */
/** How a scan at the gate was authenticated. */
export type AdmissionMethod = 'qr' | 'printed'

export interface CheckIn {
  readonly id: string
  readonly sen: string
  readonly attendeeId: string
  readonly at: string
  /**
   * Which day of the event this record belongs to. 1-based.
   *
   * Resolved by the server from the calendar, never sent by the client — so a
   * stale control in a stale tab cannot file a morning's scans under the wrong
   * heading. One record exists per attendee per day, which is what lets somebody
   * attend both days.
   */
  readonly day: number
  /**
   * The attendee's name, joined in by the server.
   *
   * It rides on the row rather than being resolved client-side against the
   * roster, because the roster is owner-only. A `gate` account can read this log
   * but cannot fetch `/admin/attendees`, so the name has to arrive with the row
   * or the log would show nothing but SENs.
   */
  readonly attendeeName: string
  /**
   * How the attendee was admitted.
   *
   * `qr` means the pass's HMAC signature verified, proving the pass was issued
   * by us for that SEN. `printed` means a bare SEN — typed by staff or read off
   * a printed barcode — where no signature is available. Recorded so an audit
   * can tell a genuine pass from a guess.
   */
  readonly method: AdmissionMethod
}

/**
 * Which day of the event it is.
 *
 * Carried on `EventInfo` rather than fetched separately, so the attendee
 * dashboard, the admin masthead and the Programme panel cannot disagree about it.
 */
export interface DayState {
  /** The day scans are currently recorded against. */
  readonly activeDay: number
  /** How many days the event runs for. */
  readonly totalDays: number
  /** An owner has pinned the day, rather than it coming from the calendar. */
  readonly overridden: boolean
  /** The day the calendar says it is, even when an override is in force. */
  readonly calendarDay?: number
}

/**
 * The guest list an organiser has uploaded.
 *
 * A count and a sample rather than every student: the full roster is every student's
 * name and SEN in one response, and there is no reason to hand it to a browser when
 * the owner already has the file. The API never returns the whole thing.
 */
export interface RosterState {
  readonly count: number
  /** Whether registration is actually restricted to this list. */
  readonly required: boolean
  readonly uploadedAt: string | null
  readonly sample: readonly { sen: string; name: string }[]
}

/** What an upload did, including what it refused and why. */
export interface RosterUploadResult {
  readonly imported: number
  readonly skipped: number
  readonly problems: readonly string[]
  readonly required: boolean
}

/**
 * The signed-in attendee's own attendance, per day.
 *
 * An array rather than a single record: attendance used to be once-in-a-lifetime,
 * and returning "the first row" would tell somebody who came on day two that they
 * arrived on day one. `totalDays` is included so the dashboard can render a row
 * for a day with no record yet — an absence the attendee can read as "not yet"
 * rather than as nothing at all.
 */
export interface MyAttendance {
  readonly records: readonly CheckIn[]
  readonly activeDay: number
  readonly totalDays: number
  readonly overridden: boolean
  /**
   * Days attendance is closed for.
   *
   * Carried here so the dashboard can tell "not yet" apart from "no longer
   * possible". Both otherwise read the same, and the panel would go on telling
   * somebody to show a pass for a day that can never be marked again.
   */
  readonly lockedDays: readonly number[]
}

/**
 * What the QR code encodes.
 *
 * `encoded` is a signed payload that CONTAINS the SEN. A gate scanner reads
 * it, the SEN is extracted, and that is the same path as scanning a printed
 * barcode — one mechanism, one write path. Signing it means a screenshot
 * cannot manufacture a record for someone who never attended.
 */
export interface Ticket {
  readonly code: string
  /** The exact string placed in the QR. */
  readonly encoded: string
}

/* ------------------------------------------------------------------- errors */

export type PortalErrorCode =
  | 'invalid_credentials'
  | 'phone_taken'
  | 'sen_taken'
  | 'username_taken'
  | 'weak_password'
  | 'invalid_ticket'
  | 'unknown_sen'
  | 'already_checked_in'
  | 'day_locked'
  | 'not_on_list'
  | 'not_found'
  | 'forbidden'
  | 'rate_limited'
  | 'network'
  | 'unknown'

export const PORTAL_ERROR_MESSAGES: Record<PortalErrorCode, string> = {
  invalid_credentials: 'Those credentials do not match our records.',
  phone_taken: 'That phone number is already registered.',
  sen_taken: 'That SEN is already registered to another attendee.',
  username_taken: 'That username is already taken.',
  weak_password: 'Password does not meet the minimum requirements.',
  invalid_ticket: 'This ticket is invalid or has already been used.',
  unknown_sen: 'No registered attendee matches that SEN.',
  already_checked_in: 'Attendance is already marked for that SEN.',
  /*
    A fallback for the case where the server's specific wording is lost. The scan
    route always names the day, because "closed" without a day is not actionable —
    but a generic message is better than rendering a machine code if it ever is.
  */
  day_locked: 'Attendance for that day is closed.',
  /*
    Says what to DO, not just what happened.

    "That SEN is not registered" would be wrong — they may well be a student, just
    not on the list this organiser uploaded — and it sends them off to make an
    account somewhere else. Naming the list, and the person who holds it, is what
    turns a dead end into an email.
  */
  not_on_list:
    'That SEN is not on the guest list for this event. Email ankith2409@gmail.com and it can be added.',
  not_found: 'We could not find that record.',
  forbidden: 'You do not have access to that.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
  network: 'Network error. Check your connection and try again.',
  unknown: 'Something went wrong. Please try again.',
}

export class PortalError extends Error {
  readonly code: PortalErrorCode
  readonly status: number
  readonly fields: Readonly<Record<string, string>>

  constructor(
    code: PortalErrorCode,
    message?: string,
    options?: { status?: number; fields?: Record<string, string> },
  ) {
    /*
      Treat a message that merely repeats the code as absent.

      The API's error class defaults its message to the code, so responses used
      to arrive as `{ code: 'unknown_sen', message: 'unknown_sen' }`. A plain
      `message ?? PORTAL_ERROR_MESSAGES[code]` then renders the machine code to
      the user instead of "No registered attendee matches that SEN." — eight
      codes were affected, including the two a gate operator reads while a queue
      waits.

      The server no longer sends a redundant message, but guarding here rather
      than at the fetch layer means no caller can reintroduce it: `PortalError`
      is the single point every error passes through, including the mock.
    */
    super(message && message !== code ? message : PORTAL_ERROR_MESSAGES[code])
    this.name = 'PortalError'
    this.code = code
    this.status = options?.status ?? 0
    this.fields = options?.fields ?? {}
  }
}

export function isPortalError(value: unknown): value is PortalError {
  return value instanceof PortalError
}