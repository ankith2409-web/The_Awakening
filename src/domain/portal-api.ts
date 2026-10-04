import type {
  AdminLoginInput,
  AdminRole,
  AdminSession,
  AdminUser,
  Attendee,
  AttendeeLoginInput,
  AttendeeRegisterInput,
  AttendeeSession,
  CheckIn,
  EventInfo,
  Team,
  Ticket,
} from './types'

/**
 * Everything the portal can ask the backend for.
 *
 * The mock and HTTP implementations are interchangeable, and no component ever
 * learns which one it is talking to.
 */
export interface PortalApi {
  /* -- attendee -------------------------------------------------------- */
  getAttendeeSession(): Promise<AttendeeSession | null>
  attendeeLogin(input: AttendeeLoginInput): Promise<AttendeeSession>
  attendeeRegister(input: AttendeeRegisterInput): Promise<AttendeeSession>
  attendeeLogout(): Promise<void>

  /*
    There is deliberately no `resetAttendeePassword`.

    One existed, and it was the most serious weakness in the portal: no OTP, no
    email, no security question, so knowing a phone number was enough to take
    over that account and present its pass. Rate limiting was the only thing
    between it and a script walking the roster, and the endpoint was under
    active probing in production.

    Recovery is now admin-mediated. An attendee asks an organiser at the desk and
    `adminSetAttendeePassword` sets a new one — an authenticated, attributable
    action instead of an unauthenticated one. Absence of the method here is the
    reminder that there is no self-service path.
  */

  /* -- admin (separate door) -------------------------------------------- */
  getAdminSession(): Promise<AdminSession | null>
  adminLogin(input: AdminLoginInput): Promise<AdminSession>
  adminLogout(): Promise<void>

  /* -- programme data --------------------------------------------------- */
  getEvent(): Promise<EventInfo>
  /** Admin-only. Teams are not exposed to the attendee portal. */
  getTeams(): Promise<readonly Team[]>

  /* -- ticket ----------------------------------------------------------- */
  /** Signed, single-use pass encoded into the attendee's QR. */
  getTicket(): Promise<Ticket>

  /* -- attendance ------------------------------------------------------- */
  /**
   * The attendee's own attendance record, or null if they have not been
   * scanned. Drives the "attendance marked" state on their dashboard.
   */
  getMyAttendance(): Promise<CheckIn | null>

  /**
   * Records attendance from a scanned SEN.
   *
   * The ONLY way attendance is ever created. There is no update and no delete
   * — the record is immutable once written.
   */
  recordAttendanceBySen(sen: string): Promise<CheckIn & { attendee: Attendee }>


  /* -- admin: directory & controls --------------------------------------- */
  listAttendees(): Promise<readonly Attendee[]>
  /** Every attendance record, oldest first. Carries the attendee name per row. */
  listAttendance(): Promise<readonly CheckIn[]>

  /**
   * Sets an attendee's password. The only password-change path in the portal.
   *
   * Owner-only. A `gate` account is refused here as firmly as it is refused the
   * roster — see `adminSetAttendeePassword` for the reasoning.
   *
   * Identified by SEN rather than phone or name: the SEN is printed on the badge
   * and is already the gate's identifier, so an organiser holding a pass does
   * not have to ask someone to spell out a number.
   *
   * Revokes every existing session for that attendee, so a password change
   * actually locks the previous holder out.
   */
  adminSetAttendeePassword(input: {
    sen: string
    password: string
  }): Promise<{ attendee: { id: string; name: string; sen: string }; sessionsRevoked: boolean }>

  updateEventPhase(phase: EventInfo['phase']): Promise<EventInfo>
  updateAgendaItem(
    id: string,
    patch: Partial<Pick<EventInfo['agenda'][number], 'status'>>,
  ): Promise<EventInfo['agenda'][number]>
}

/*
  There is deliberately no staff-management surface here.

  One existed — a Staff panel with create, role change, password reset and
  deactivation — and it was removed. There is exactly one `gate` credential and a
  couple of `owner` accounts, so a settings screen managed four rows that change
  perhaps twice before the event, while adding three routes that only an `owner`
  session could reach.

  Accounts are provisioned by `scripts/manage-staff.mjs` instead. That is the right
  shape when the number of staff is known and small: provisioning is a rare,
  deliberate act done from a machine with database access, not a button that is
  one stolen owner session away from being pressed by someone else.
*/

export type {
  AdminUser,
  AdminRole,
  Team,
  EventInfo,
  Attendee,
  CheckIn,
  Ticket,
}
