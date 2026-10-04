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
  StaffAccount,
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

  /* -- admin: staff (owner only) ------------------------------------------ */

  /**
   * Every staff account. Owner-only.
   *
   * Exists so a volunteer can be created or disabled on event day without a
   * redeploy, and so "who else has access" has an answer.
   */
  listStaff(): Promise<readonly StaffAccount[]>

  /**
   * Creates a staff account and returns it.
   *
   * The password is chosen here and handed over in person — no invitation, no
   * reset link, no second channel that could leak a credential.
   */
  createStaff(input: {
    username: string
    displayName: string
    password: string
    role: AdminRole
  }): Promise<{ staff: StaffAccount }>

  /**
   * Changes another account's role, password, or whether it is active.
   *
   * Revokes that account's live sessions, so a demotion takes effect on the next
   * request rather than whenever a cookie happens to expire. Every field is
   * optional; omit one to leave it alone.
   *
   * The server refuses to let you change your own access, and refuses to remove
   * the last active owner.
   */
  updateStaff(
    id: string,
    patch: { role?: AdminRole; password?: string; active?: boolean },
  ): Promise<{ staff: StaffAccount }>
}

export type {
  AdminUser,
  AdminRole,
  StaffAccount,
  Team,
  EventInfo,
  Attendee,
  CheckIn,
  Ticket,
}
