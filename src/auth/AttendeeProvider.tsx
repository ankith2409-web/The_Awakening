import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { portalApi, PortalError, PORTAL_ERROR_MESSAGES } from '@/api'
import type { Attendee, EventInfo, MyAttendance, Ticket } from '@/domain/types'
import { normalisePhone, normaliseSen } from '@/domain/phone'
import { AttendeeContext, type AttendeeContextValue } from './contexts'

/**
 * How often the dashboard re-checks for its attendance record.
 *
 * Only ever runs between sign-in and the gate scan. Five seconds is quick enough
 * that the attendee sees "marked" while still holding their phone up, and slow
 * enough to be irrelevant on a serverless bill.
 */
const ATTENDANCE_POLL_MS = 5_000

export function AttendeeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AttendeeContextValue['status']>('initialising')
  const [attendee, setAttendee] = useState<Attendee | null>(null)
  const [event, setEvent] = useState<EventInfo | null>(null)
  const [attendance, setAttendance] = useState<MyAttendance | null>(null)
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [loadingData, setLoadingData] = useState(false)
  const [error, setError] = useState<AttendeeContextValue['error']>(null)

  useEffect(() => {
    let cancelled = false

    portalApi
      .getAttendeeSession()
      .then((session) => {
        if (cancelled) return
        if (session) {
          setAttendee(session.attendee)
          setStatus('active')
        } else {
          setStatus('anonymous')
        }
      })
      .catch(() => {
        // A failed probe must never lock anyone out of the sign-in screen.
        if (!cancelled) setStatus('anonymous')
      })

    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Loads the dashboard payload. Never throws — a failure degrades the
   * dashboard to empty panels rather than blocking the whole page.
   */
  const loadDashboard = useCallback(async () => {
    setLoadingData(true)
    const [eventResult, ticketResult, attendanceResult] = await Promise.allSettled([
      portalApi.getEvent(),
      portalApi.getTicket(),
      portalApi.getMyAttendance(),
    ])

    if (eventResult.status === 'fulfilled') setEvent(eventResult.value)
    if (ticketResult.status === 'fulfilled') setTicket(ticketResult.value)
    if (attendanceResult.status === 'fulfilled') setAttendance(attendanceResult.value)

    setLoadingData(false)
  }, [])

  useEffect(() => {
    if (status === 'active') void loadDashboard()
    // Synchronisation with an external system on session resolve; the loading
    // flag inside loadDashboard is not a render cascade.
  }, [status, loadDashboard])

  /**
   * Watches for the gate marking this attendee present.
   *
   * Attendance is written by the admin's scanner on a *different* device, so
   * nothing pushes the change into this open tab. Previously the dashboard
   * fetched once on mount, so an attendee had to reload by hand to see "marked"
   * after walking through the gate — at exactly the moment they are looking at
   * the screen for it.
   *
   * Polling stops once this attendee is marked for the day being scanned into.
   *
   * That is NOT "once any record exists", which is what the old code did. A
   * record is per day now, so an attendee who came on day one would have their
   * polling stop on day one morning and sit there showing day two as "not yet"
   * until they manually reloaded — after walking through the gate again. The
   * log is append-only and records are immutable, so a record for today's day is
   * genuinely the last thing a poll can learn.
   */
  useEffect(() => {
    if (status !== 'active' || loadingData) return

    const today = event?.activeDay ?? 1
    const markedForToday =
      attendance?.records?.some((record) => record.day === today) ?? false
    if (markedForToday) return

    let cancelled = false

    const poll = async () => {
      try {
        const current = await portalApi.getMyAttendance()
        if (!cancelled && current !== null) setAttendance(current)
      } catch {
        // A failed poll is not worth surfacing — it would flash an error at
        // someone who is only holding their phone up. The next tick retries.
      }
    }

    const id = window.setInterval(() => {
      // Skip while hidden: an attendee showing their pass has this tab in the
      // background, and an idle phone should not be polling a database.
      if (document.visibilityState === 'visible') void poll()
    }, ATTENDANCE_POLL_MS)

    // Catches the common case immediately: they showed the pass, looked away,
    // and switched back to this tab. No need to wait out the interval.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [status, attendance, loadingData, event?.activeDay])

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
    async (name: string, phone: string, password: string, remember: boolean) => {
      setError(null)
      try {
        const session = await portalApi.attendeeLogin({
          name,
          phone: normalisePhone(phone),
          password,
          remember,
        })
        setAttendee(session.attendee)
        setStatus('active')
      } catch (cause) {
        toError(cause)
      }
    },
    [toError],
  )

  const register = useCallback(
    async (name: string, phone: string, password: string, sen: string) => {
      setError(null)
      try {
        const session = await portalApi.attendeeRegister({
          name,
          phone: normalisePhone(phone),
          password,
          sen: normaliseSen(sen),
          remember: true,
        })
        setAttendee(session.attendee)
        setStatus('active')
      } catch (cause) {
        toError(cause)
      }
    },
    [toError],
  )

  const logout = useCallback(async () => {
    setError(null)
    await portalApi.attendeeLogout()
    // Clear cached panels so the next sign-in never shows stale data.
    setAttendee(null)
    setEvent(null)
    setTicket(null)
    setAttendance(null)
    setStatus('anonymous')
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const value = useMemo<AttendeeContextValue>(
    () => ({
      status,
      attendee,
      event,
      attendance,
      ticket,
      loadingData,
      error,
      login,
      register,
      logout,
      clearError,
    }),
    [
      status,
      attendee,
      event,
      attendance,
      ticket,
      loadingData,
      error,
      login,
      register,
      logout,
      clearError,
    ],
  )

  return (
    <AttendeeContext.Provider value={value}>{children}</AttendeeContext.Provider>
  )
}
