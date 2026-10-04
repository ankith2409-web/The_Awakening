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
 * `owner` runs the event — the roster, credentials, the programme, staff
 * accounts. `gate` is a volunteer at the door: mark attendance, read the log,
 * read teams.
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

/**
 * A staff account as the admin portal sees it. Never carries a hash.
 *
 * `active: false` is a disabled account rather than a deleted one, so the name
 * stays attached to audit rows the account already produced.
 */
export interface StaffAccount {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly role: AdminRole
  readonly active: boolean
  readonly createdAt: string | null
}

/** The change made to a staff account, for the audit line in the Staff panel. */
export type StaffAction = 'created' | 'role_changed' | 'reset' | 'deactivated' | 'reactivated'

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
  /** Which door it was scanned at. */
  readonly gate: string
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