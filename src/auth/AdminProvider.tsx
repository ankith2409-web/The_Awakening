import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { portalApi, PortalError, PORTAL_ERROR_MESSAGES } from '@/api'
import type {
  AdminRole,
  AdminUser,
  AgendaItem,
  Attendee,
  CheckIn,
  EventInfo,
  StaffAccount,
  Team,
} from '@/domain/types'
import { AdminContext, type AdminContextValue } from './contexts'

export function AdminProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AdminContextValue['status']>('initialising')
  const [admin, setAdmin] = useState<AdminUser | null>(null)
  const [attendees, setAttendees] = useState<readonly Attendee[]>([])
  const [attendance, setAttendance] = useState<readonly CheckIn[]>([])
  const [teams, setTeams] = useState<readonly Team[]>([])
  const [event, setEvent] = useState<EventInfo | null>(null)
  const [loadingData, setLoadingData] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<AdminContextValue['error']>(null)
  /*
    A single recent scan, not a message string.

    Held as the record rather than a formatted sentence so the panel can show
    the attendee's name, their SEN and how they were admitted at a glance — a
    gate operator needs to read that back to the person in front of them. A
    pre-formatted "marked present" string cannot be laid out, and this state
    was previously written on every scan but never rendered, so a successful
    scan produced no confirmation at all.
  */
  const [lastScan, setLastScan] = useState<AdminContextValue['lastScan']>(null)
  /** Staff accounts. Owner-only — never fetched for a `gate` session. */
  const [staff, setStaff] = useState<readonly StaffAccount[]>([])

  useEffect(() => {
    let cancelled = false

    portalApi
      .getAdminSession()
      .then((session) => {
        if (cancelled) return
        if (session) {
          setAdmin(session.admin)
          setStatus('active')
        } else {
          setStatus('anonymous')
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('anonymous')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoadingData(true)

    /*
      The roster is only ever requested by an owner.

      Not just because the server refuses a `gate` account — calling it anyway
      would put every attendee's name, phone and SEN through the network tab of
      a volunteer's phone on every refresh. The request is not made.

      `allSettled` throughout, because one failing panel must not blank the whole
      admin view; the roster is simply one of the promises for some roles and not
      for others.
    */
    const isOwner = admin?.role === 'owner'

    const [attendeesResult, attendanceResult, teamsResult, eventResult] =
      await Promise.allSettled([
        isOwner ? portalApi.listAttendees() : Promise.resolve<readonly Attendee[]>([]),
        portalApi.listAttendance(),
        portalApi.getTeams(),
        portalApi.getEvent(),
      ])

    if (attendeesResult.status === 'fulfilled') setAttendees(attendeesResult.value)
    if (attendanceResult.status === 'fulfilled') setAttendance(attendanceResult.value)
    if (teamsResult.status === 'fulfilled') setTeams(teamsResult.value)
    if (eventResult.status === 'fulfilled') setEvent(eventResult.value)

    setLoadingData(false)
  }, [admin?.role])

  useEffect(() => {
    if (status === 'active') void refresh()
    // Synchronisation with an external system on session resolve.
  }, [status, refresh])

  /** Stable: only touches `setError`, which React guarantees is stable. */
  const toError = useCallback((cause: unknown): never => {
    setError(
      cause instanceof PortalError
        ? { code: cause.code, message: cause.message }
        : { code: 'unknown', message: PORTAL_ERROR_MESSAGES.unknown },
    )
    throw cause
  }, [])

  const login = useCallback(
    async (username: string, password: string) => {
      setError(null)
      try {
        const session = await portalApi.adminLogin({ username, password })
        setAdmin(session.admin)
        setStatus('active')
      } catch (cause) {
        toError(cause)
      }
    },
    [toError],
  )

  const logout = useCallback(async () => {
    setError(null)
    await portalApi.adminLogout()
    setAdmin(null)
    setAttendees([])
    setAttendance([])
    setTeams([])
    setEvent(null)
    setStatus('anonymous')
  }, [])

  /**
   * Records one scan.
   *
   * Returns the created record on success and `null` on failure rather than
   * throwing, because this runs on every scan at a busy gate: the UI wants to
   * stay usable and show the next code immediately either way.
   */
  const scanAttendance = useCallback(
    async (sen: string) => {
      setError(null)
      setScanning(true)
      // The previous confirmation goes the moment a new scan begins, so a stale
      // name is never left on screen next to the person now standing there.
      setLastScan(null)
      try {
        const result = await portalApi.recordAttendanceBySen(sen)
        // Append locally so the log updates without a full refetch, keeping
        // the gate moving. The server order is authoritative on refresh.
        setAttendance((current) => [...current, stripAttendee(result)])
        /*
          Kept as a record, not a sentence, so the panel can show the name, the
          SEN and how the person was admitted. A gate operator reads that back
          to the attendee, and "which pass method" is the audit question — a
          single formatted string cannot carry either as layout.
        */
        setLastScan({
          name: result.attendee.name,
          sen: result.sen,
          at: result.at,
          method: result.method,
        })
        return {
          name: result.attendee.name,
          sen: result.sen,
          at: result.at,
          method: result.method,
        }
      } catch (cause) {
        setError(
          cause instanceof PortalError
            ? { code: cause.code, message: cause.message }
            : { code: 'unknown', message: PORTAL_ERROR_MESSAGES.unknown },
        )
        return null
      } finally {
        setScanning(false)
      }
    },
    [],
  )

  /**
   * Sets an attendee's password, on behalf of the attendee.
   *
   * This replaces an unauthenticated self-service reset that was the most
   * serious weakness the portal had: knowing a phone number was enough to take
   * over that account and present its pass. Requiring an admin session is the
   * whole fix, so this deliberately has no rate limiter — an attacker who
   * cannot authenticate cannot reach the route, and a counter in front of an
   * authenticated door would only slow down legitimate desk staff.
   *
   * Resolves to the attendee, or `null` on failure. `null` is what the panel
   * keys off to keep the form open; the reason itself goes to the banner.
   */
  const setAttendeePassword = useCallback(
    async (sen: string, password: string) => {
      setError(null)
      try {
        const result = await portalApi.adminSetAttendeePassword({ sen, password })
        return { name: result.attendee.name, sen: result.attendee.sen }
      } catch (cause) {
        setError(
          cause instanceof PortalError
            ? { code: cause.code, message: cause.message }
            : { code: 'unknown', message: PORTAL_ERROR_MESSAGES.unknown },
        )
        return null
      }
    },
    [],
  )

  /*
    Programme edits do not surface a banner.

    They used to call `setNotice(...)`, which set state nothing ever read — the
    scan confirmation was the only intended consumer of that slot. Silently
    rewriting the agenda from the portal and showing no acknowledgement is a
    real gap, so it is called out rather than left as dead code: the panel
    re-reads the event after a change, which is the confirmation that the write
    landed, but a toast for it would want its own dismissal rule.

    A deliberate omission, not an oversight. Say the word and it gets one.
  */
  const setEventPhase = useCallback(
    async (phase: EventInfo['phase']) => {
      setError(null)
      try {
        setEvent(await portalApi.updateEventPhase(phase))
      } catch (cause) {
        toError(cause)
      }
    },
    [toError],
  )

  const setAgendaStatus = useCallback(
    async (id: string, agendaStatus: AgendaItem['status']) => {
      setError(null)
      try {
        await portalApi.updateAgendaItem(id, { status: agendaStatus })
        setEvent((current) =>
          current === null
            ? current
            : {
                ...current,
                agenda: current.agenda.map((item) =>
                  item.id === id ? { ...item, status: agendaStatus } : item,
                ),
              },
        )
      } catch (cause) {
        toError(cause)
      }
    },
    [toError],
  )

  const clearError = useCallback(() => setError(null), [])
  const clearLastScan = useCallback(() => setLastScan(null), [])

  /*
    Staff management.

    Owner-only by construction: these are only ever reached from the Staff panel,
    which an owner is the only role that can render. The server refuses them
    regardless — this is convenience, not the control.

    Every one returns null on failure rather than throwing, matching
    `scanAttendance`: the panel stays mounted and shows the outcome inline, and
    the reason goes to the banner.
  */
  const refreshStaff = useCallback(async () => {
    if (admin?.role !== 'owner') return
    try {
      setStaff(await portalApi.listStaff())
    } catch {
      // A failed staff list must not break the portal; the panel shows what it
      // has and the banner carries the reason.
    }
  }, [admin?.role])

  const createStaff = useCallback(
    async (input: {
      username: string
      displayName: string
      password: string
      role: AdminRole
    }): Promise<StaffAccount | null> => {
      setError(null)
      try {
        const result = await portalApi.createStaff(input)
        setStaff((current) => [...current, result.staff])
        return result.staff
      } catch (cause) {
        toError(cause)
        return null
      }
    },
    [toError],
  )

  const updateStaff = useCallback(
    async (
      id: string,
      patch: { role?: AdminRole; password?: string; active?: boolean },
    ): Promise<StaffAccount | null> => {
      setError(null)
      try {
        const result = await portalApi.updateStaff(id, patch)
        setStaff((current) => current.map((person) => (person.id === id ? result.staff : person)))
        return result.staff
      } catch (cause) {
        toError(cause)
        return null
      }
    },
    [toError],
  )

  const value = useMemo<AdminContextValue>(
    () => ({
      status,
      admin,
      attendees,
      attendance,
      teams,
      event,
      staff,
      loadingData,
      scanning,
      error,
      lastScan,
      login,
      logout,
      refresh,
      scanAttendance,
      setAttendeePassword,
      setEventPhase,
      setAgendaStatus,
      refreshStaff,
      createStaff,
      updateStaff,
      clearError,
      clearLastScan,
    }),
    [
      status,
      admin,
      attendees,
      attendance,
      teams,
      event,
      staff,
      loadingData,
      scanning,
      error,
      lastScan,
      login,
      logout,
      refresh,
      scanAttendance,
      setAttendeePassword,
      setEventPhase,
      setAgendaStatus,
      refreshStaff,
      createStaff,
      updateStaff,
      clearError,
      clearLastScan,
    ],
  )

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
}

/** Drops the joined attendee so the stored log stays a flat `CheckIn[]`. */
function stripAttendee(record: CheckIn & { attendee: Attendee }): CheckIn {
  // `method` is carried through deliberately: the log needs it to show how each
  // attendee was admitted. `attendeeName` comes from the record rather than from
  // the joined row so the log renders for a `gate` account, which is never sent
  // the roster.
  const { id, sen, attendeeId, at, gate, method, attendeeName } = record
  return { id, sen, attendeeId, at, gate, method, attendeeName }
}
