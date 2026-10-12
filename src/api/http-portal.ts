import {
  PortalError,
  type AdminLoginInput,
  type AdminSession,
  type Attendee,
  type CheckIn,
  type CheckInOutcome,
  type DayState,
  type EventInfo,
  type PortalErrorCode,
  type RegistrationMode,
  type Team,
  type TeamPassReport,
  type TeamRegistration,
} from '@/domain/types'
import type { PortalApi } from '@/domain/portal-api'
/**
 * Real HTTP implementation.
 *
 * Sessions are httpOnly cookies, so this client has no notion of a token — it
 * calls endpoints and reads results. That is what keeps it interchangeable
 * with the mock.
 */
export class HttpPortalApi implements PortalApi {
  readonly #baseUrl: string

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '')
  }

  /* --------------------------------------------------------- transport */

  /*
    Every request is bounded.

    `fetch` has no default timeout, so a connection that stalls — weak venue
    wifi, mobile data dropping mid-request, a captive portal that accepts the
    socket and never answers — leaves the promise pending FOREVER. Confirmed by
    `scripts/repro-hanging-fetch.mjs`.

    That is worst on the session probe. `AttendeeProvider` only sets a status in
    `.then` or `.catch`, so a probe that never settles leaves `status` as
    `'initialising'` and `Guard` renders the boot screen indefinitely — an
    attendee on a bad connection could not reach the sign-in form at all, and a
    gate scanner mid-queue would hang on a scan with no way to retry.

    The budgets are deliberately different. The session probe gets the shorter
    one because it gates the very first paint and its failure mode is a screen
    with no way forward — failing fast to the sign-in form is far better than
    waiting. Writes get longer because they do real work: a cold serverless
    start plus a bcrypt compare plus a Postgres round trip.
  */
  static readonly #PROBE_TIMEOUT_MS = 8_000
  static readonly #REQUEST_TIMEOUT_MS = 20_000


  /* --------------------------------------------------------------- admin */

  async getAdminSession(): Promise<AdminSession | null> {
    return this.#request<AdminSession | null>(
      'GET',
      '/admin/session',
      undefined,
      HttpPortalApi.#PROBE_TIMEOUT_MS,
    )
  }

  adminLogin(input: AdminLoginInput): Promise<AdminSession> {
    return this.#request('POST', '/admin/login', input)
  }

  adminLogout(): Promise<void> {
    return this.#request('POST', '/admin/logout')
  }

  /* ---------------------------------------------------------- programme */

  getEvent(): Promise<EventInfo> {
    return this.#request('GET', '/event')
  }

  /*
    Check in. No cookie is sent and none is expected back.

    The page this is called from has never had a session and never will, so a
    request that quietly carried one would be relying on a credential that does
    not exist to work. It is the plainest POST in the client, which is the right
    shape for the plainest action in the product.

    No day is sent, and that is not an omission. The server resolves which day is
    live, because a `day` in the body would let a stale page file a whole queue
    under a heading of its own choosing.
  */
  checkIn(input: { name: string; phone: string; sen: string }): Promise<CheckInOutcome> {
    return this.#request('POST', '/attendee/checkin', input)
  }

  getAttendanceForSen(sen: string): Promise<readonly CheckIn[]> {
    /*
      The SEN goes in the query string, not the body.

      A GET is the right verb for a read, and a GET has no body by specification -
      putting it in one works on this server and works nowhere else. Encoded
      rather than interpolated raw, because a SEN from the URL is untrusted input
      and `&` in it would otherwise read as another parameter.
    */
    return this.#request<{ records: CheckIn[] }>(
      'GET',
      '/attendee/attendance?sen=' + encodeURIComponent(sen),
    ).then((body) => body.records)
  }

  registerTeam(input: {
    name: string
    leaderName: string
    leaderEmail: string
    leaderPhone: string
    leaderSen: string
    members: readonly { name: string; sen: string }[]
  }): Promise<TeamRegistration> {
    return this.#request('POST', '/team/register', input)
  }

  listTeams(): Promise<readonly Team[]> {
    return this.#request<{ teams: Team[] }>('GET', '/admin/teams').then((body) => body.teams)
  }

  emailTeamPasses(): Promise<TeamPassReport> {
    return this.#request('POST', '/admin/teams/email')
  }

  /**
   * The only write path for attendance; the log is append-only.
   *
   * No `day` in the body. The server resolves it from the calendar, so a stale
   * control in a stale tab cannot file a morning's scans under the wrong heading.
   */
  recordAttendanceBySen(sen: string) {
    return this.#request<CheckIn & { attendee: Attendee; dayState: DayState }>(
      'POST',
      '/admin/attendance',
      { sen },
    )
  }

  /* -------------------------------------------------------- admin tools */

  listAttendees(): Promise<readonly Attendee[]> {
    return this.#request('GET', '/admin/attendees')
  }

  listAttendance(): Promise<readonly CheckIn[]> {
    return this.#request('GET', '/admin/attendance')
  }


  updateEventPhase(phase: EventInfo['phase']): Promise<EventInfo> {
    return this.#request('PATCH', '/admin/event', { phase })
  }

  updateEventDay(dayOverride: number | null): Promise<EventInfo> {
    return this.#request('PATCH', '/admin/event', { dayOverride })
  }

  async setLockedDays(lockedDays: readonly number[]): Promise<EventInfo> {
    return this.#request('PATCH', '/admin/event', { lockedDays })
  }

  /**
   * Opens or shuts the event to everybody.
   *
   * One switch for both doors: 'closed' refuses team registration AND attendance.
   * Distinct from `setLockedDays`, which closes attendance for particular days and
   * leaves the challenge open — a team may register on the evening of day one.
   */
  async setRegistrationMode(mode: RegistrationMode): Promise<EventInfo> {
    return this.#request('PATCH', '/admin/event', { registrationMode: mode })
  }

  /*
    The rows are POSTed as structured JSON rather than the file being uploaded.

    Two reasons. The file has already been parsed in the browser, so the server never
    has to understand CSV or xlsx — which is the whole reason there is no spreadsheet
    library on the server. And the server then validates every row with the same
    functions registration uses, so a client that skipped the checks gains nothing.

  /* --------------------------------------------------------- transport */

  async #request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs: number = HttpPortalApi.#REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    let response: Response

    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        credentials: 'include',
        headers:
          body === undefined
            ? { Accept: 'application/json' }
            : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        // See the timeout note above. Without this the promise can stay pending
        // forever and the boot screen never resolves.
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      /*
        A timeout is reported as its own thing rather than a generic network
        failure. They look the same to the user but the next action differs: a
        dead connection wants a retry later, a slow one usually succeeds on a
        second attempt. Collapsing them tells the attendee nothing useful.
      */
      const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError'
      throw timedOut
        ? new PortalError('network', 'That took too long. Check your connection and try again.', {
            status: 0,
          })
        : new PortalError('network')
    }

    // 401 on a session probe means "not signed in", which is not an error.
    if (response.status === 401 && path.endsWith('/session')) {
      return null as T
    }

    if (!response.ok) throw await toPortalError(response)
    if (response.status === 204) return undefined as T

    try {
      return (await response.json()) as T
    } catch {
      throw new PortalError('unknown', 'Malformed response from server.', {
        status: response.status,
      })
    }
  }
}

/** Translates arbitrary server errors into our closed taxonomy. */
async function toPortalError(response: Response): Promise<PortalError> {
  const status = response.status

  let code: PortalErrorCode = 'unknown'
  let message: string | undefined
  let fields: Record<string, string> = {}

  try {
    const body = (await response.json()) as {
      code?: unknown
      message?: unknown
      errors?: unknown
    }
    if (typeof body.code === 'string') code = body.code as PortalErrorCode
    if (typeof body.message === 'string') message = body.message
    if (body.errors && typeof body.errors === 'object') {
      fields = body.errors as Record<string, string>
    }
  } catch {
    // Non-JSON body (a proxy error page) — fall through to status mapping.
  }

  if (code === 'unknown') {
    if (status === 401 || status === 403) code = 'forbidden'
    else if (status === 404) code = 'not_found'
    else if (status === 409) code = 'phone_taken'
    else if (status === 422) code = 'weak_password'
    else if (status === 429) code = 'rate_limited'
    else if (status >= 500) code = 'network'
  }

  return new PortalError(code, message, { status, fields })
}