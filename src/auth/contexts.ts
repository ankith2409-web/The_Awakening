import { createContext, useContext } from 'react'
import type {
  AdmissionMethod,
  AdminRole,
  AdminUser,
  AgendaItem,
  Attendee,
  CheckIn,
  EventInfo,
  PortalErrorCode,
  StaffAccount,
  Team,
  Ticket,
} from '@/domain/types'

export type SessionStatus = 'initialising' | 'active' | 'anonymous'

export interface ErrorState {
  readonly code: PortalErrorCode
  readonly message: string
}

export interface AttendeeContextValue {
  readonly status: SessionStatus
  readonly attendee: Attendee | null
  readonly event: EventInfo | null
  /** The attendee's own attendance record, or null if not yet scanned. */
  readonly attendance: CheckIn | null
  readonly ticket: Ticket | null
  readonly loadingData: boolean
  readonly error: ErrorState | null

  login: (name: string, phone: string, password: string, remember: boolean) => Promise<void>
  register: (
    name: string,
    phone: string,
    password: string,
    sen: string,
  ) => Promise<void>
  logout: () => Promise<void>
  clearError: () => void
}

export const AttendeeContext = createContext<AttendeeContextValue | null>(null)

export function useAttendee(): AttendeeContextValue {
  const context = useContext(AttendeeContext)
  if (context === null) {
    throw new Error('useAttendee must be used inside <AttendeeProvider>.')
  }
  return context
}

export interface AdminContextValue {
  readonly status: SessionStatus
  readonly admin: AdminUser | null
  /**
   * The attendee roster. EMPTY for a `gate` account.
   *
   * Not hidden — never fetched. `GET /admin/attendees` returns every name, phone
   * and SEN, so the provider does not call it unless the signed-in admin is an
   * owner, and the server refuses it otherwise.
   */
  readonly attendees: readonly Attendee[]
  /** Append-only attendance log, oldest first. Carries the attendee name per row. */
  readonly attendance: readonly CheckIn[]
  readonly teams: readonly Team[]
  readonly event: EventInfo | null
  /** Staff accounts. Owner-only; empty for a `gate` session. */
  readonly staff: readonly StaffAccount[]
  readonly loadingData: boolean
  /** True while a scan is in flight. */
  readonly scanning: boolean
  readonly error: ErrorState | null
  /**
   * The most recent successful scan, or `null`.
   *
   * A record rather than a formatted string: the panel shows the name, the SEN
   * and the admission method as separate fields, because a gate operator reads
   * the name back to the attendee and the method is the audit answer to "was
   * this a verified pass or a number someone typed".
   *
   * Cleared when the next scan begins, so a stale name is never on screen
   * beside the person now standing there.
   */
  readonly lastScan: {
    readonly name: string
    readonly sen: string
    readonly at: string
    readonly method: AdmissionMethod
  } | null

  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  /**
   * Records attendance from a scanned SEN. Resolves to the created record, or
   * `null` if the code was rejected — it does not throw, because this runs on
   * every scan and the gate must stay usable.
   */
  scanAttendance: (
    sen: string,
  ) => Promise<{ name: string; sen: string; at: string; method: AdmissionMethod } | null>
  /**
   * Sets an attendee's password. The only password-change path in the portal.
   *
   * Resolves to the attendee it acted on, or `null` if the change was refused
   * (unregistered SEN, weak password, lost admin session). It does not throw,
   * matching `scanAttendance` — the desk panel wants to stay usable and render
   * the outcome inline rather than unmount.
   *
   * Takes the SEN, not a phone number or a name. The SEN is printed on the
   * badge, it is already the gate's identifier, and unlike a name it is not
   * shared between two people on the roster.
   */
  setAttendeePassword: (
    sen: string,
    password: string,
  ) => Promise<{ name: string; sen: string } | null>
  setEventPhase: (phase: EventInfo['phase']) => Promise<void>
  setAgendaStatus: (id: string, status: AgendaItem['status']) => Promise<void>

  /* -- staff (owner only) ------------------------------------------------- */

  /** Re-reads the staff list. No-op for a `gate` session. */
  refreshStaff: () => Promise<void>
  /** Creates an account. Resolves to it, or `null` if refused. */
  createStaff: (input: {
    username: string
    displayName: string
    password: string
    role: AdminRole
  }) => Promise<StaffAccount | null>
  /**
   * Changes another account's role, password or active flag.
   *
   * Resolves to the updated account, or `null` if refused. The server will not
   * let you change your own access or remove the last active owner, so a `null`
   * here is always a rule rather than a fault.
   */
  updateStaff: (
    id: string,
    patch: { role?: AdminRole; password?: string; active?: boolean },
  ) => Promise<StaffAccount | null>
  /** Clears the current error banner. */
  clearError: () => void
  /**
   * Clears the scan confirmation.
   *
   * Distinct from `clearError` because a success and a failure must never be
   * dismissed by the same action — clearing the banner after a failed scan must
   * not also wipe the previous attendee's name.
   */
  clearLastScan: () => void
}

export const AdminContext = createContext<AdminContextValue | null>(null)

export function useAdmin(): AdminContextValue {
  const context = useContext(AdminContext)
  if (context === null) {
    throw new Error('useAdmin must be used inside <AdminProvider>.')
  }
  return context
}
