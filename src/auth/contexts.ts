import { createContext, useContext } from 'react'
import type {
  AdmissionMethod,
  AdminUser,
  Attendee,
  CheckIn,
  EventInfo,
  PortalErrorCode,
  RegistrationMode,
} from '@/domain/types'

export type SessionStatus = 'initialising' | 'active' | 'anonymous'

export interface ErrorState {
  readonly code: PortalErrorCode
  readonly message: string
}

/*
  There is no attendee context any more.

  It held a session, an account, a ticket and that person's attendance — every one
  of which required an account, and there are none. The check-in page talks to
  `portalApi` directly, because there is no session to inherit and nothing to keep
  in sync.

  Deleting it rather than emptying it is the point: an empty attendee context would
  be a context whose values are always null, which is a thing to read past rather
  than a thing that tells you the feature is gone.
*/

export interface AdminContextValue {
  readonly status: SessionStatus
  readonly admin: AdminUser | null
  /**
   * Everyone who has checked in. EMPTY for a `gate` account.
   *
   * Not hidden — never fetched. `GET /admin/attendees` returns every name, phone
   * and SEN, so the provider does not call it unless the signed-in admin is an
   * owner, and the server refuses it otherwise.
   */
  readonly attendees: readonly Attendee[]
  /** Append-only attendance log, oldest first. Carries the attendee name per row. */
  readonly attendance: readonly CheckIn[]
  readonly event: EventInfo | null
  readonly loadingData: boolean
  /** True while a scan is in flight. */
  readonly scanning: boolean
  readonly error: ErrorState | null
  /**
   * The most recent successful scan, or `null`.
   *
   * A record rather than a formatted string: the panel shows the name, the SEN
   * and the admission method as separate fields, because a gate operator reads
   * the name back to the attendee and the method is the audit answer to "was this
   * a verified pass or a number someone typed".
   *
   * Cleared when the next scan begins, so a stale name is never on screen beside
   * the person now standing there.
   */
  readonly lastScan: {
    readonly name: string
    readonly sen: string
    readonly at: string
    readonly method: AdmissionMethod
    /**
     * Which day the record was written against, resolved by the server.
     *
     * On the confirmation because the operator is the only person who can tell
     * whether that is right. If the portal records a morning of scans under the
     * wrong day, nobody notices until the export — and the person holding the
     * phone would have seen it immediately if it had been on screen.
     */
    readonly day: number
    readonly totalDays: number
  } | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  /**
   * Records attendance from a scanned SEN at the door.
   *
   * Resolves to the created record, or `null` if it was rejected — it does not
   * throw, because this runs on every scan and the gate must stay usable.
   */
  scanAttendance: (
    sen: string,
  ) => Promise<{
    name: string
    sen: string
    at: string
    method: AdmissionMethod
    day: number
    totalDays: number
  } | null>
  setEventPhase: (phase: EventInfo['phase']) => Promise<void>
  /**
   * Pins the day attendance is recorded against, or clears the pin.
   *
   * This is the control that decides what a self check-in marks. `null` returns
   * to following the calendar, which is the state this belongs in between events.
   * A number is for opening day two on the morning, or for a schedule that has
   * slipped.
   */
  updateEventDay: (day: number | null) => Promise<void>
  /**
   * Replaces the set of days attendance is closed for.
   *
   * Takes the final set, not a toggle, so a retry cannot reopen a day the
   * operator meant to keep shut. A closed day refuses new check-ins before
   * anything is written, so this takes effect immediately rather than from the
   * next request onwards.
   */
  setLockedDays: (days: readonly number[]) => Promise<void>
  /**
   * Opens or shuts the event for everybody.
   *
   * `'closed'` refuses team registration AND attendance together, on the next
   * request. Distinct from `setLockedDays`, which closes attendance for particular
   * days and deliberately leaves the challenge open.
   */
  setRegistrationMode: (mode: RegistrationMode) => Promise<void>
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