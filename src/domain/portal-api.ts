import type {
  AdminLoginInput,
  AdminRole,
  AdminSession,
  AdminUser,
  Attendee,
  CheckIn,
  CheckInOutcome,
  DayState,
  EventInfo,
  Team,
  TeamMember,
  TeamPassReport,
  TeamRegistration,
  RegistrationMode,
} from './types'
/**
 * Everything the portal can ask the backend for.
 *
 * The mock and HTTP implementations are interchangeable, and no component ever
 * learns which one it is talking to.
 */
export interface PortalApi {
  /* -- attendee -------------------------------------------------------- */
  /*
    CHECK IN. The whole attendee surface.

    There is no session, no account and no password, so there is nothing to sign
    in to and nothing to sign out of. `attendeeRegister`, `attendeeLogin`,
    `getAttendeeSession`, `attendeeLogout`, `verifyAttendeePassword` and
    `changeOwnPassword` were removed rather than left behind: every one existed
    only to create or maintain an account, and a half-removed one is a way back
    in.

    Takes NO day. The server resolves it, because a `day` field in the body would
    let a stale page file a whole queue under any heading it liked, and the export
    would be the only place that ever showed it.
  */
  checkIn(input: {
    name: string
    phone: string
    sen: string
  }): Promise<CheckInOutcome>
  /**
   * Which days this SEN is marked for.
   *
   * A lookup rather than a disclosure: a student already knows their own SEN, and
   * a SEN nobody has used returns nothing at all. It exists for the case where
   * somebody tapped once on a bad connection and has no other way to find out
   * whether it landed.
   */
  getAttendanceForSen(sen: string): Promise<readonly CheckIn[]>
  /* -- teams ------------------------------------------------------------- */
  /**
   * Registers a team for the challenge.
   *
   * PUBLIC and unauthenticated, for the same reason check-in is: a student scans a
   * poster and that is the whole interaction.
   *
   * The leader is sent as a member too, with `isLeader`, rather than being a
   * separate kind of person the server has to splice back in. The server decides
   * which member is the leader; the client cannot claim a teammate is.
   *
   * Takes no team size. `TEAM_SIZE` is a constant the server reads from the same
   * place the form does, and a client that sends a different number is refused
   * rather than accommodated.
   */
  registerTeam(input: {
    name: string
    leaderName: string
    leaderEmail: string
    leaderPhone: string
    leaderSen: string
    members: readonly { name: string; sen: string }[]
  }): Promise<TeamRegistration>
  /* -- admin (separate door) -------------------------------------------- */
  /**
   * Every registered team with its members, newest first.
   *
   * Owner-only. The admin portal polls this so a team appears the moment it
   * registers, without a refresh.
   */
  listTeams(): Promise<readonly Team[]>
  /**
   * Emails the designed pass to every leader.
   *
   * Sequential on the server, never parallel: a burst of twenty sends at once is
   * what gets a sending domain rate-limited, and the result is a partial send that
   * reports itself as a failure with no way to tell which half landed.
   */
  emailTeamPasses(): Promise<TeamPassReport>
  getAdminSession(): Promise<AdminSession | null>
  adminLogin(input: AdminLoginInput): Promise<AdminSession>
  adminLogout(): Promise<void>
  /* -- programme data --------------------------------------------------- */
  getEvent(): Promise<EventInfo>
  /* -- attendance ------------------------------------------------------- */
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
  /* -- event controls --------------------------------------------------- */
  /**
   * Moves the event between registration, live and completed.
   *
   * Owner-only. Every event field returns whole, so one control can never leave
   * another one out of sync with it.
   */
  updateEventPhase(phase: EventInfo['phase']): Promise<EventInfo>
  /**
   * Which day is live, or null to derive it from the calendar.
   *
   * The check-in route reads this to decide what day a mark belongs to, so this is
   * the control that moves the event from day one to day two.
   */
  updateEventDay(dayOverride: number | null): Promise<EventInfo>
  /**
   * Which days attendance is CLOSED for.
   *
   * Separate from the override on purpose: which day is live and which days are
   * finished are different decisions, and an organiser who has locked day one
   * while day two is live has made both.
   *
   * A closed day refuses new check-ins before anything is written.
   */
  setLockedDays(lockedDays: readonly number[]): Promise<EventInfo>
  /**
   * Opens or shuts the event to everybody.
   *
   * ONE SWITCH, BOTH DOORS. `registrationMode: 'closed'` refuses team registration
   * AND attendance, on the next request, with nothing already on a form escaping
   * it. It is the control an organiser reaches for when the event is over, or when
   * the hall has filled.
   *
   * Separate from `setLockedDays` on purpose. Closing day one's attendance is a
   * decision about attendance; a team may still be formed on the evening of day one
   * for the brief the next morning. Closing the event is a decision about both, and
   * conflating them would mean an organiser could not close one without the other.
   */
  setRegistrationMode(mode: RegistrationMode): Promise<EventInfo>
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
  EventInfo,
  Attendee,
  CheckIn,
  CheckInOutcome,
  DayState,
  Team,
  TeamMember,
  TeamPassReport,
  TeamRegistration,
}

export { TEAM_SIZE } from './types'