import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { portalApi, PortalError, PORTAL_ERROR_MESSAGES } from '@/api'
import type {
  AdminUser,
  AgendaItem,
  Attendee,
  CheckIn,
  EventInfo,
  RegistrationMode,
  Team,
} from '@/domain/types'
import { AdminContext, type AdminContextValue } from './contexts'
import { LIVE_POLL_MS, eventChanged } from './liveEvent'
import { probeSession } from './probeSession'

/**
 * How often the control room re-reads the event and the attendance log.
 *
 * This is the gap between an owner pressing "Close Day 1" on the laptop and a
 * volunteer's phone at the gate showing it. Without it, the phone keeps offering to
 * scan into a day that is closed, and the volunteer finds out by being refused —
 * with a queue watching.
 */
const ADMIN_POLL_MS = LIVE_POLL_MS

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

  /**
   * Counts writes, so the poll can recognise its own answer as stale.
   *
   * A ref rather than state because it must be readable inside a callback and must
   * not itself cause a render. Bumped by every mutation, before the request is sent.
   */
  const writeSeq = useRef(0)

  /** Mirrors `scanning` for the poll's interval callback, which closes over nothing. */
  const scanningRef = useRef(false)
  scanningRef.current = scanning

  useEffect(() => {
    let cancelled = false

    /* A failed probe is not anonymous — see `probeSession`. */
    void probeSession(() => portalApi.getAdminSession()).then((result) => {
      if (cancelled) return
      if (result.known && result.value) {
        setAdmin(result.value.admin)
        setStatus('active')
      } else {
        setStatus('anonymous')
      }
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

  /*
    Keeps this device live.

    Two devices is the normal setup on the day: an owner with the laptop managing
    phase, locks and registration, and a volunteer with a phone at the door. Every
    change the owner makes is invisible to the phone until something re-reads it, so
    a volunteer scans into a day that was closed an hour ago, or keeps telling a queue
    that registration is open after it has been shut.

    Only the event and the log are polled. The attendee ROSTER is not, on purpose: it
    changes when somebody registers, which is not a door-side event, and it is the
    one response that carries every attendee's name, phone and SEN. Refetching that
    every five seconds to chase a registration would put the whole roll through the
    network of every open owner device for no benefit. Adding somebody by hand
    refreshes it, and the Refresh button is there.

    `loadingData` is deliberately NOT touched. A poll that flipped the skeletons on
    and off every five seconds would make the whole portal strobe.

    `lastScan` is deliberately NOT touched either. It is the confirmation a volunteer
    is reading aloud to somebody standing in front of them, and a background refresh
    must never take it away mid-sentence.
  */
  useEffect(() => {
    if (status !== 'active') return

    let cancelled = false

    const poll = async () => {
      // Captured before the requests go out. If a write lands while they are in
      // flight, their answer describes the past and is discarded rather than being
      // allowed to undo the write — the classic stale-response flicker, which on a
      // switch would show the old position until the next tick.
      const seq = writeSeq.current

      const [eventResult, attendanceResult] = await Promise.allSettled([
        portalApi.getEvent(),
        portalApi.listAttendance(),
      ])

      if (cancelled || seq !== writeSeq.current) return

      if (eventResult.status === 'fulfilled') {
        const next = eventResult.value
        setEvent((current) => (eventChanged(current, next) ? next : current))
      }
      if (attendanceResult.status === 'fulfilled') {
        const next = attendanceResult.value
        setAttendance((current) => (sameLog(current, next) ? current : next))
      }
    }

    const id = window.setInterval(() => {
      // A scan in flight owns the screen. It resolves in well under a second and
      // appends locally, so there is nothing to gain from racing it.
      if (document.visibilityState === 'visible' && !scanningRef.current) void poll()
    }, ADMIN_POLL_MS)

    // Somebody switching back to the tab after a meeting, an hour after the owner
    // changed something, must not have to wait out the interval to see it.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !scanningRef.current) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [status])

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
          // From the server's answer, never from local state: the whole point is
          // that the client has no opinion about which day it is.
          day: result.day,
          totalDays: result.dayState.totalDays,
        })
        return {
          name: result.attendee.name,
          sen: result.sen,
          at: result.at,
          method: result.method,
          day: result.day,
          totalDays: result.dayState.totalDays,
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
      writeSeq.current += 1
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
      writeSeq.current += 1
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
      writeSeq.current += 1
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

  const updateEventDay = useCallback(
    async (day: number | null) => {
      setError(null)
      writeSeq.current += 1
      try {
        // The whole `EventInfo` comes back, so the day change and the agenda agree
        // immediately rather than drifting until the next refresh.
        setEvent(await portalApi.updateEventDay(day))
      } catch (cause) {
        toError(cause)
      }
    },
    [toError],
  )

  const setRegistrationMode = useCallback(
    async (mode: RegistrationMode) => {
      setError(null)
      writeSeq.current += 1
      try {
        // Whole `EventInfo` back, so the switch, the guest list panel and the
        // registration form all reflect the change from one response.
        setEvent(await portalApi.setRegistrationMode(mode))
      } catch (cause) {
        toError(cause)
      }
    },
    [toError],
  )

  const setLockedDays = useCallback(
    async (days: readonly number[]) => {
      setError(null)
      writeSeq.current += 1
      try {
        // Whole `EventInfo` back, so the lock badges, the scan panel state and the
        // programme all reflect the change from one response.
        setEvent(await portalApi.setLockedDays(days))
      } catch (cause) {
        toError(cause)
      }
    },
    [toError],
  )

  const clearError = useCallback(() => setError(null), [])
  const clearLastScan = useCallback(() => setLastScan(null), [])


  const value = useMemo<AdminContextValue>(
    () => ({
      status,
      admin,
      attendees,
      attendance,
      teams,
      event,
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
      updateEventDay,
      setLockedDays,
      setRegistrationMode,
      setAgendaStatus,
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
      updateEventDay,
      setLockedDays,
      setRegistrationMode,
      setAgendaStatus,
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
  const { id, sen, attendeeId, at, method, day, attendeeName } = record
  return { id, sen, attendeeId, at, method, day, attendeeName }
}

/**
 * Whether two attendance logs are the same set of records.
 *
 * The poll runs every few seconds and the log is append-only, so "nothing new" is by
 * far the common answer. Replacing the array on every tick would re-render the whole
 * control room for no reason, several times a minute, for as long as it is open.
 *
 * Compared on `id` and length rather than by reference: the server assigns `id`, the
 * log only ever grows, and a record is immutable so an existing id never changes
 * meaning. A gate account and an owner therefore see the same comparison, and neither
 * has to be trusted to be in step.
 */
function sameLog(current: readonly CheckIn[], next: readonly CheckIn[]): boolean {
  if (current === next) return true
  if (current.length !== next.length) return false
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]?.id !== next[index]?.id) return false
  }
  return true
}
