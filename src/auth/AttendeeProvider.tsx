import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { portalApi, PortalError, PORTAL_ERROR_MESSAGES } from '@/api'
import type { Attendee, CheckIn, EventInfo, MyAttendance, Ticket } from '@/domain/types'
import { normalisePhone, normaliseSen } from '@/domain/phone'
import { AttendeeContext, type AttendeeContextValue } from './contexts'
import { LIVE_POLL_MS, eventChanged } from './liveEvent'
import { probeSession } from './probeSession'

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

    /*
      A failed probe is NOT anonymous — see `probeSession`.

      This used to `.catch(() => setStatus('anonymous'))`, which turned one slow
      request on venue wifi into a redirect to /login with a valid cookie still in
      the jar. Manual refresh was the reliable way to reproduce it, because a
      refresh is a cold serverless start on a phone that has just woken up: the
      single most likely request in the whole session to be slow.

      Two failures, then anonymous — enough to ride out a blip, not so many that a
      genuinely offline visitor sits on a boot screen for the better part of a
      minute. If the retry DOES find a session, the status flips to `active` and the
      route guard sends them to the dashboard on its own.
    */
    void probeSession(() => portalApi.getAttendeeSession()).then((result) => {
      if (cancelled) return
      if (result.known) {
        if (result.value) {
          setAttendee(result.value.attendee)
          setStatus('active')
        } else {
          setStatus('anonymous')
        }
      } else {
        setStatus('anonymous')
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  /*
    The event, fetched for EVERYONE rather than only for a signed-in attendee.

    `loadDashboard` below only runs once there is a session, which left the
    registration form with no way to know whether registration was open. The
    consequence was that a visitor whose organiser had closed sign-ups still typed
    name, phone, SEN and password, and only then read "registration is closed" —
    four fields of effort to be told something the page could have said on arrival.

    `GET /event` is public and already on the critical path for the dashboard, so the
    cost is one small request for a visitor who has not yet signed in, and it replaces
    the separate fetch the register view would otherwise have made for itself.

    This effect is superseded by the poll below, which subsumes the initial load.
  */

  /**
   * Keeps the event live, for everyone, for ever.
   *
   * This is the one thing that makes an organiser's switch show up on somebody else's
   * phone without a reload: closing registration, opening or closing a day, moving
   * the day override, changing the phase, or correcting a speaker in the agenda all
   * land here within `LIVE_POLL_MS`.
   *
   * It runs for anonymous visitors too, not only signed-in ones. The register form
   * is precisely where a stale value is most expensive — somebody filling in four
   * fields against a portal that has already been shut.
   *
   * Three rules, each of which is the fix for a specific way this goes wrong:
   *
   *   - Never stop for a settled state. An earlier version of the attendance poll
   *     stopped once the attendee was marked; that is right for records and was
   *     actively harmful for everything else, because "nothing more to learn" is a
   *     property of a record and never of the event.
   *   - Never apply an identical payload. See `eventSignature`.
   *   - Never poll a hidden tab. An attendee holding their pass has this tab in the
   *     background, and an idle phone should not be spending a database on it. The
   *     first thing that happens on becoming visible is a fetch, so nothing is lost
   *     by skipping the ticks — the `visibilitychange` listener covers the case
   *     where the tab has been asleep for an hour.
   */
  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const next = await portalApi.getEvent()
        if (cancelled) return
        // Compared against the value already held, so an unchanged event costs a
        // request and nothing else. Overwriting unconditionally would re-render the
        // whole dashboard every five seconds regardless.
        setEvent((current) => (eventChanged(current, next) ? next : current))
      } catch {
        // Never surfaced. A failed poll on somebody's phone must not become an error
        // banner over their pass, and the next tick retries. Leaving the last good
        // value on screen is the correct failure: slightly stale beats blank.
      }
    }

    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void poll()
    }, LIVE_POLL_MS)

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
   *
   * Stopping here is safe ONLY because this poll now carries nothing but records.
   * It used to return the day state as well, and stopping froze that too: reopening
   * a closed day left every already-marked attendee reading "Closed" until they
   * reloaded. Day state is polled unconditionally in the effect above and is read
   * from `event`, never from here.
   */
  useEffect(() => {
    if (status !== 'active' || loadingData) return

    const today = event?.activeDay ?? 1
    const markedForToday =
      attendance?.records?.some((record) => record.day === today) ?? false
    if (markedForToday) return

    /*
      Stop if the day being waited on is closed.

      Polling exists for one reason: the gate marks this attendee on a different
      device, and nothing pushes that here. But on a day an organiser has closed, no
      mark can ever arrive — so the poll is asking a question whose answer cannot
      change, once every `ATTENDANCE_POLL_MS`, for as long as the tab is open.

      That is somebody's phone battery, on a screen they are holding at a venue,
      spent on a request that cannot succeed.
    */
    if (event?.lockedDays?.includes(today)) return

    let cancelled = false

    const poll = async () => {
      try {
        const current = await portalApi.getMyAttendance()
        if (cancelled || current === null) return
        /*
          Only applied when the records actually differ.

          An append-only log means an unchanged result is the common case, and writing
          it anyway would replace the object and re-render the dashboard on every
          tick. The comparison is on SEN and day together: the log is keyed by both,
          and a repeated scan is refused server-side rather than inserted twice.
        */
        setAttendance((held) => {
          if (held !== null && sameRecords(held.records, current.records)) return held
          return current
        })
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
  }, [status, attendance, loadingData, event?.activeDay, event?.lockedDays])

  /**
 * Whether two attendance records are the same set.
 *
 * The poll runs every few seconds and the log is append-only, so "nothing new" is by
 * far the common answer. Replacing the object on every tick would re-render the
 * dashboard for no reason several times a minute, for as long as somebody has it
 * open on their phone.
 *
 * Compared on SEN and day together rather than by reference: those are the log's
 * keys, a record is immutable once written, and the server refuses a repeat scan, so
 * a matching set means nothing changed. A `null` is "not loaded yet", which is never
 * equal to a loaded empty list.
 */
function sameRecords(
  current: readonly CheckIn[],
  next: readonly CheckIn[],
): boolean {
  if (current.length !== next.length) return false
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]?.sen !== next[index]?.sen) return false
    if (current[index]?.day !== next[index]?.day) return false
  }
  return true
}

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

  /*
    Registration hands back the password the PORTAL chose.

    It is returned to the caller rather than kept here, because it exists exactly once
    and the only place it can be is the screen the attendee is looking at. Holding it
    in context would put a plaintext credential in a place that survives navigation
    and a re-render, for no gain.

    The attendee is NOT made `active` here. The register view stays in control of what
    happens next — the read-back, then the offer to change it — and only navigates to
    the dashboard once that is done. `setStatus` happens in the view, deliberately, so
    the guard cannot redirect out from under the read-back step.
  */
  const register = useCallback(
    async (name: string, phone: string, sen: string) => {
      setError(null)
      try {
        const result = await portalApi.attendeeRegister({
          name,
          phone: normalisePhone(phone),
          sen: normaliseSen(sen),
        })
        setAttendee(result.attendee)
        return result
      } catch (cause) {
        // Rethrown, so the type is `AttendeeRegistration` rather than
        // `AttendeeRegistration | undefined`. The view never reaches the line after
        // a failure — `toError` sets the banner and throws — so nothing has to
        // handle an `undefined` that cannot occur.
        toError(cause)
        throw cause
      }
    },
    [toError],
  )

  /**
   * Ends the read-back and lets the attendee through to their pass.
   *
   * Separate from `register` so the account is created and the session issued in one
   * place, while the decision to navigate is the view's.
   */
  const completeRegistration = useCallback(() => {
    setStatus('active')
  }, [])

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
      completeRegistration,
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
      completeRegistration,
      logout,
      clearError,
    ],
  )

  return (
    <AttendeeContext.Provider value={value}>{children}</AttendeeContext.Provider>
  )
}
