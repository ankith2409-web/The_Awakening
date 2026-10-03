import {
  PortalError,
  type AdminLoginInput,
  type AdminSession,
  type AgendaItem,
  type Attendee,
  type AttendeeLoginInput,
  type AttendeeRegisterInput,
  type AttendeeSession,
  type CheckIn,
  type EventInfo,
  type PasswordResetInput,
  type PasswordResetResult,
  type PortalErrorCode,
  type Team,
  type Ticket,
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

  /* ------------------------------------------------------------ attendee */

  async getAttendeeSession(): Promise<AttendeeSession | null> {
    return this.#request<AttendeeSession | null>(
      'GET',
      '/attendee/session',
      undefined,
      HttpPortalApi.#PROBE_TIMEOUT_MS,
    )
  }

  attendeeLogin(input: AttendeeLoginInput): Promise<AttendeeSession> {
    return this.#request('POST', '/attendee/login', {
      name: input.name,
      phone: input.phone,
      password: input.password,
      remember: input.remember,
    })
  }

  attendeeRegister(input: AttendeeRegisterInput): Promise<AttendeeSession> {
    return this.#request('POST', '/attendee/register', {
      name: input.name,
      phone: input.phone,
      password: input.password,
      // Required. Attendance is keyed on SEN, so omitting it fails the request
      // outright — and the in-memory mock tolerated the omission, so this only
      // surfaced against the real database.
      sen: input.sen,
    })
  }

  attendeeLogout(): Promise<void> {
    return this.#request('POST', '/attendee/logout')
  }

  resetAttendeePassword(input: PasswordResetInput): Promise<PasswordResetResult> {
    return this.#request('POST', '/attendee/password/reset', {
      phone: input.phone,
      password: input.password,
    })
  }

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

  getTeams(): Promise<readonly Team[]> {
    return this.#request('GET', '/teams')
  }

  getTicket(): Promise<Ticket> {
    return this.#request('GET', '/attendee/ticket')
  }

  getMyAttendance(): Promise<CheckIn | null> {
    return this.#request('GET', '/attendee/attendance')
  }

  /** The only write path for attendance; the log is append-only. */
  recordAttendanceBySen(sen: string): Promise<CheckIn & { attendee: Attendee }> {
    return this.#request('POST', '/admin/attendance', { sen })
  }

  /* -------------------------------------------------------- admin tools */

  listAttendees(): Promise<readonly Attendee[]> {
    return this.#request('GET', '/admin/attendees')
  }

  listAttendance(): Promise<readonly CheckIn[]> {
    return this.#request('GET', '/admin/attendance')
  }

  updateAgendaItem(
    id: string,
    patch: Partial<AgendaItem>,
  ): Promise<AgendaItem> {
    return this.#request(
      'PATCH',
      `/admin/agenda/${encodeURIComponent(id)}`,
      patch,
    )
  }

  updateEventPhase(phase: EventInfo['phase']): Promise<EventInfo> {
    return this.#request('PATCH', '/admin/event', { phase })
  }

  /* --------------------------------------------------------- transport */

  async #request<T>(
    method: 'GET' | 'POST' | 'PATCH',
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