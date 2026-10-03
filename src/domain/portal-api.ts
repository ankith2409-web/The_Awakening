import type {
  AdminLoginInput,
  AdminSession,
  AdminUser,
  Attendee,
  AttendeeLoginInput,
  AttendeeRegisterInput,
  AttendeeSession,
  CheckIn,
  EventInfo,
  PasswordResetInput,
  PasswordResetResult,
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

  /**
   * Sets a new password from a phone number alone.
   *
   * Deliberately unverified — there is no OTP, email or security question, so
   * knowing a number is enough to take over that account. That is the
   * organiser's explicit call, and the server compensates with rate limiting
   * and a uniform response rather than pretending it is secure.
   *
   * Returns the same message whether or not the number is registered, so the
   * UI must not branch on the result.
   */
  resetAttendeePassword(input: PasswordResetInput): Promise<PasswordResetResult>

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
  /** Every attendance record, newest last. */
  listAttendance(): Promise<readonly CheckIn[]>
  updateEventPhase(phase: EventInfo['phase']): Promise<EventInfo>
  updateAgendaItem(
    id: string,
    patch: Partial<Pick<EventInfo['agenda'][number], 'status'>>,
  ): Promise<EventInfo['agenda'][number]>
}

export type { AdminUser, Team, EventInfo, Attendee, CheckIn, Ticket }
