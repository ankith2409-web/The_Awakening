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
  DayState,
  EventInfo,
  MyAttendance,
  RosterState,
  RosterUploadResult,
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
   * The attendee's own attendance, one record per day they were marked.
   *
   * Was a single record or null, which was correct while attendance was
   * once-in-a-lifetime. Returning "the first row" now would tell somebody who
   * came on day two that they arrived on day one.
   */
  getMyAttendance(): Promise<MyAttendance | null>

  /**
   * Records attendance from a scanned SEN.
   *
   * The ONLY way attendance is ever created. There is no update and no delete
   * — the record is immutable once written.
   *
   * Takes no day. The server resolves it from the calendar, so there is nothing at
   * the door that can be left on the wrong setting. The response carries the day it
   * recorded, so the confirmation can name it.
   *
   * Somebody already marked on an earlier day is admitted again — that is how
   * attending both days works. A conflict means they are already marked for
   * *today*.
   */
  recordAttendanceBySen(
    sen: string,
  ): Promise<CheckIn & { attendee: Attendee; dayState: DayState }>


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
  /**
   * Pins the day attendance is recorded against, or clears the pin.
   *
   * `null` returns to following the calendar, which is the normal state. A number
   * makes the portal treat that day as current regardless of the date — how you
   * exercise day two before it arrives, and how you tell it when a schedule has
   * slipped.
   *
   * Independent of `phase`, so setting one does not clear the other.
   */
  updateEventDay(dayOverride: number | null): Promise<EventInfo>
  /**
   * Replaces the whole set of days attendance is closed for.
   *
   * Takes the intended final set rather than a single day to toggle, so the write
   * is idempotent — which is what makes it safe to retry on a flaky connection at a
   * busy door. Sending "unlock day 1" as a delta needs the client to hold the
   * current set and get it right under exactly the conditions where it matters.
   */
  setLockedDays(lockedDays: readonly number[]): Promise<EventInfo>

  /**
   * The guest list: who is allowed to register.
   *
   * A COUNT and a SAMPLE, never the whole list — the full roster is every student's
   * name and SEN, which is exactly what a `gate` account must never receive. The
   * owner has the file they uploaded, so nothing is lost by not echoing it back.
   */
  getRoster(): Promise<RosterState>

  /**
   * Replaces the guest list wholesale.
   *
   * `required` is passed explicitly rather than inferred, so uploading a file never
   * silently changes who may register. That decision belongs to the organiser.
   */
  uploadRoster(
    rows: readonly { name: string; sen: string }[],
    required: boolean,
  ): Promise<RosterUploadResult>

  /** Empties the list and reopens registration. */
  clearRoster(): Promise<RosterState>
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
  DayState,
  MyAttendance,
  Ticket,
}
