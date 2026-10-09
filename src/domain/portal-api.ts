import type {
  AdminLoginInput,
  AdminRole,
  AdminSession,
  AdminUser,
  Attendee,
  AttendeeLoginInput,
  AttendeeRegisterInput,
  AttendeeRegistration,
  AttendeeSession,
  CheckIn,
  DayState,
  EventInfo,
  MyAttendance,
  RegistrationMode,
  RosterRows,
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

  /**
   * Registers, and returns the password the PORTAL chose.
   *
   * The attendee does not pick one. They used to, and then typed it twice on a phone
   * at a desk in a queue, where one mistyped character locked them out of their own
   * pass. The generated password comes back ONCE, here, and only its bcrypt hash is
   * ever stored.
   */
  attendeeRegister(input: AttendeeRegisterInput): Promise<AttendeeRegistration>

  /**
   * Confirms the attendee can reproduce the password they were just given.
   *
   * Separate from the client-side "do the two boxes match" check, which cannot catch
   * somebody who misread the password and then faithfully typed the same wrong thing
   * twice. Session-gated, and a mismatch is an answer rather than an error — it is
   * the expected result of reading something aloud.
   */
  verifyAttendeePassword(password: string): Promise<{ readonly matches: boolean }>

  /**
   * Replaces one's own password, immediately after registering.
   *
   * NOT the recovery path. Somebody locked out entirely has no self-service route and
   * must ask at the desk — see the note on `resetAttendeePassword` below. This is for
   * somebody being offered a replacement for a password they already hold.
   *
   * Other sessions are revoked; the one making the request is kept, because signing
   * the attendee out of the tab they are standing in is indistinguishable from the
   * portal logging people out by itself.
   */
  changeOwnPassword(input: {
    currentPassword: string
    newPassword: string
  }): Promise<{ readonly ok: true }>

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
   * Opens, restricts or closes registration.
   *
   * Separate from the guest list on purpose. The list is data; this is the decision
   * about what the data means, and they are changed at different moments — one when
   * the list is prepared, the other when the doors open and close.
   */
  setRegistrationMode(mode: RegistrationMode): Promise<EventInfo>

  /**
   * Creates one attendee by hand.
   *
   * The only route that makes an account without the registration form, and so the
   * only one that can bypass the guest list. Owner-only, audited, and it issues no
   * session: the attendee is not at the computer, and signing them in on a device
   * they may never see again — without them typing the password the organiser just
   * read out — defeats the point of setting one.
   */
  createAttendee(input: {
    name: string
    phone: string
    sen: string
    password: string
  }): Promise<Attendee>

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
   * The mode travels with the upload rather than being set separately, so "save the
   * list and start using it" is one action instead of two, and there is no window
   * where the list has changed but the decision about it has not.
   */
  uploadRoster(
    rows: readonly { name: string; sen: string }[],
    mode: RegistrationMode,
  ): Promise<RosterUploadResult>

  /**
   * Empties the list.
   *
   * Does NOT reopen registration. Clearing a spreadsheet is not the same decision as
   * changing who may register, and doing both on one click would shut the door to
   * everybody as a side effect of tidying up.
   */
  clearRoster(): Promise<RosterState>

  /**
   * Every row on the guest list, owner-only, so the names can be checked.
   *
   * A SEPARATE call from `getRoster`, which stays a count and an eight-row sample.
   * The panel header only needs to know whether the upload worked; holding five
   * hundred students in memory to report "500" is not worth it, and the full list is
   * every student's name and SEN, which must never reach a `gate` device.
   *
   * `truncated` is part of the contract rather than an implementation detail: if a cap
   * is ever hit the check is incomplete and has to say so, because "I looked at the
   * names and they are all correct" is a claim somebody will act on.
   */
  listRosterRows(): Promise<RosterRows>

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
