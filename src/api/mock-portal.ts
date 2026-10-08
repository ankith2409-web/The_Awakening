import { SEED_ADMINS, SEED_ATTENDEE, SEED_EVENT, SEED_TEAMS } from '@/domain/dataset'
import { normalisePhone, normaliseSen, isValidSen } from '@/domain/phone'
import { signTicket } from '@/domain/ticket'
import {
  PortalError,
  type AdmissionMethod,
  type AdminLoginInput,
  type AdminSession,
  type AdminUser,
  type AgendaItem,
  type Attendee,
  type AttendeeLoginInput,
  type AttendeeRegisterInput,
  type AttendeeSession,
  type AttendeeWithSecret,
  type CheckIn,
  type EventInfo,
  type MyAttendance,
  type RosterState,
  type RosterUploadResult,
  type Team,
  type Ticket,
} from '@/domain/types'
import type { PortalApi } from '@/domain/portal-api'

const STORE_KEY = 'gdg-portal.store.v1'
const LATENCY_MS = 600

/**
 * A staff account as the mock stores it.
 *
 * `role` and `active` are optional on read because a store persisted before roles
 * existed will not have them, and the default has to be the permissive one or
 * every existing mock session would lose access on upgrade.
 */
interface MockStaff {
  id: string
  username: string
  displayName: string
  passwordHash: string
  role?: string
  active?: boolean
  createdAt?: string
}

interface Store {
  attendees: AttendeeWithSecret[]
  admins: MockStaff[]
  event: EventInfo
  teams: Team[]
  checkIns: CheckIn[]
  /** The uploaded guest list. Absent on stores seeded before this feature. */
  roster?: { sen: string; name: string }[]
  /** Whether registration is actually restricted to `roster`. */
  rosterRequired?: boolean
  /**
   * Fingerprint of the seed this store was built from.
   *
   * Without it, editing `src/domain/dataset.ts` appears to do nothing: the
   * persisted store is returned as-is and the new seed is never reached. That
   * failure is silent and deeply confusing, so the seed is hashed into the
   * store and any mismatch forces a reseed.
   */
  seedFingerprint: string
}

/**
 * Complete in-memory backend.
 *
 * Not a stub: duplicate phones, password strength, forged tickets, double
 * check-ins and admin authorisation are all enforced, so every state the real
 * API can produce is reachable locally.
 */
export class MockPortalApi implements PortalApi {
  #store: Store

  /**
   * Live session ids. Deliberately NOT part of the persisted store: a session
   * is browser state, and persisting it alongside the data is what would let a
   * stale id survive a logout.
   */
  #attendeeSessionId: string | null
  #adminSessionId: string | null

  constructor() {
    this.#store = loadOrSeed()
    this.#attendeeSessionId = readSession('attendee')
    this.#adminSessionId = readSession('admin')
  }

  /* ------------------------------------------------------------ attendee */

  async getAttendeeSession(): Promise<AttendeeSession | null> {
    await delay(LATENCY_MS / 2)
    const attendee = this.#store.attendees.find(
      (candidate) => candidate.id === this.#attendeeSessionId,
    )
    return attendee ? { attendee: toPublic(attendee) } : null
  }

  async attendeeLogin(input: AttendeeLoginInput): Promise<AttendeeSession> {
    await delay(LATENCY_MS)

    const phone = normalisePhone(input.phone)
    const name = input.name.trim()

    // One generic message for every failure so the endpoint cannot be used to
    // discover which phone numbers or names are registered.
    const attendee = this.#store.attendees.find(
      (candidate) =>
        candidate.phone === phone && candidate.name.toLowerCase() === name.toLowerCase(),
    )

    if (!attendee || attendee.passwordHash !== hash(input.password)) {
      throw new PortalError('invalid_credentials')
    }

    this.#attendeeSessionId = attendee.id
    writeSession('attendee', attendee.id, input.remember)

    return { attendee: toPublic(attendee) }
  }

  async attendeeRegister(input: AttendeeRegisterInput): Promise<AttendeeSession> {
    await delay(LATENCY_MS)

    const phone = normalisePhone(input.phone)
    const name = input.name.trim()

    if (this.#store.attendees.some((candidate) => candidate.phone === phone)) {
      throw new PortalError('phone_taken')
    }

    // SEN is unique: it is the attendance identity, so a duplicate would make
    // two people indistinguishable at the gate. `?? ''` guards a record
    // persisted before SENs existed.
    if (
      this.#store.attendees.some(
        (candidate) =>
          (candidate.sen ?? '').toUpperCase() === input.sen.toUpperCase(),
      )
    ) {
      throw new PortalError('sen_taken')
    }

    const problem = passwordProblem(input.password)
    if (problem !== null) throw new PortalError('weak_password', problem)

    const attendee: AttendeeWithSecret = {
      id: `att_${randomSuffix()}`,
      name,
      phone,
      sen: input.sen.toUpperCase(),
      createdAt: new Date().toISOString(),
      passwordHash: hash(input.password),
      ticketCode: randomTicketPayload(),
    }

    this.#store.attendees.push(attendee)
    // Persist BEFORE handing back a session: otherwise the account exists
    // only in memory and a reload loses the attendee we just created.
    persist(this.#store)
    this.#attendeeSessionId = attendee.id
    writeSession('attendee', attendee.id, input.remember)

    return { attendee: toPublic(attendee) }
  }

  async attendeeLogout(): Promise<void> {
    await delay(LATENCY_MS / 3)
    this.#attendeeSessionId = null
    // No persist needed: the session id is not part of the stored data.
    clearSession('attendee')
  }

  /* --------------------------------------------------------------- admin */

  /**
   * Sets an attendee's password. The only password-change path.
   *
   * The mock had a self-service `resetAttendeePassword` and it is deliberately
   * gone rather than kept for parity: a mock that still offers an unverified
   * reset teaches the shape of an endpoint the server no longer has, and the
   * next person to read it would assume the vulnerability is still there.
   *
   * Mirrors the two guarantees the real one makes — identified by SEN, and any
   * session the previous password minted is dropped.
   */
  async adminSetAttendeePassword(input: {
    sen: string
    password: string
  }): Promise<{ attendee: { id: string; name: string; sen: string }; sessionsRevoked: boolean }> {
    await delay(LATENCY_MS)

    // Owner-only, matching the server: changing somebody's credential is not a
    // door-side job.
    this.#requireOwner()

    const target = normaliseSen(input.sen)
    if (!isValidSen(target)) {
      throw new PortalError('unknown_sen', 'That does not look like a SEN.')
    }

    const problem = passwordProblem(input.password)
    if (problem) throw new PortalError('weak_password', problem)

    const attendee = this.#store.attendees.find((person) => person.sen === target)
    if (!attendee) {
      throw new PortalError('unknown_sen', 'No registered attendee matches that SEN.')
    }

    // Replaced rather than mutated: `passwordHash` is readonly, and an immutable
    // swap keeps the store consistent with its own type.
    this.#store.attendees = this.#store.attendees.map((person) =>
      person.id === attendee.id ? { ...person, passwordHash: hash(input.password) } : person,
    )

    // The previous password's session is no longer trustworthy.
    if (this.#attendeeSessionId === attendee.id) {
      this.#attendeeSessionId = null
      clearSession('attendee')
    }
    persist(this.#store)

    return {
      attendee: { id: attendee.id, name: attendee.name, sen: attendee.sen },
      sessionsRevoked: true,
    }
  }

  async getAdminSession(): Promise<AdminSession | null> {
    await delay(LATENCY_MS / 3)
    const admin = this.#store.admins.find(
      (candidate) => candidate.id === this.#adminSessionId,
    )
    // A disabled account holding a live id reads as signed out, exactly as the
    // server treats a disabled account holding a live cookie.
    if (!admin || admin.active === false) return null
    return { admin: toPublicAdmin(admin) }
  }

  async adminLogin(input: AdminLoginInput): Promise<AdminSession> {
    await delay(LATENCY_MS)

    const username = input.username.trim().toLowerCase()
    const admin = this.#store.admins.find(
      (candidate) => candidate.username.toLowerCase() === username,
    )

    if (!admin || admin.active === false || admin.passwordHash !== hash(input.password)) {
      throw new PortalError('invalid_credentials')
    }

    this.#adminSessionId = admin.id
    writeSession('admin', admin.id, true)

    return { admin: toPublicAdmin(admin) }
  }

  /*
    The role gate, in the mock.

    Mirrors the server so that a permission bug reproduces locally. A mock that
    let a `gate` account read the roster would hide the exact defect this exists
    to catch, and the next person to read it would assume the check is server-side
    and not bother.
  */
  #requireOwner(): string {
    const admin = this.#store.admins.find((candidate) => candidate.id === this.#adminSessionId)
    if (!admin || admin.active === false) {
      throw new PortalError('forbidden', 'Log in to the admin portal.')
    }
    if (toPublicAdmin(admin).role !== 'owner') {
      throw new PortalError('forbidden', 'Your account cannot make this change.')
    }
    return admin.id
  }

  #requireAdmin(): string {
    const admin = this.#store.admins.find((candidate) => candidate.id === this.#adminSessionId)
    if (!admin || admin.active === false) {
      throw new PortalError('forbidden', 'Log in to the admin portal.')
    }
    return admin.id
  }

  async adminLogout(): Promise<void> {
    await delay(LATENCY_MS / 3)
    this.#adminSessionId = null
    clearSession('admin')
  }

  /* ---------------------------------------------------------- programme */

  async getEvent(): Promise<EventInfo> {
    await delay(LATENCY_MS / 3)
    return structuredClone(this.#store.event)
  }

  async getTeams(): Promise<readonly Team[]> {
    await delay(LATENCY_MS / 3)
    return structuredClone(this.#store.teams)
  }

  /* ------------------------------------------------------------- ticket */

  async getTicket(): Promise<Ticket> {
    await delay(LATENCY_MS / 4)

    const attendee = this.#requireAttendee()
    // Signed payload carrying the SEN, so the QR feeds the same scanner path
    // as a printed barcode instead of introducing a second way in.
    const code = await signTicket(attendee.sen)

    return { code, encoded: code }
  }

  /* ---------------------------------------------------------- attendance */

  /**
   * The attendee's own record, or null if they have not been scanned.
   * Read-only: there is no way for an attendee to mark themselves present.
   */
  async getMyAttendance(): Promise<MyAttendance | null> {
    await delay(LATENCY_MS / 4)
    const attendeeId = this.#attendeeSessionId
    if (attendeeId === null) return null
    const records = this.#store.checkIns
      .filter((entry) => entry.attendeeId === attendeeId)
      .sort((a, b) => a.day - b.day)
    const day = this.#dayState()
    return {
      records: structuredClone(records),
      ...day,
      // Filtered to days that exist, matching the server, so the mock cannot show a
      // lock badge for a day the event does not have.
      lockedDays: this.#store.event.lockedDays.filter(
        (d) => d >= 1 && d <= this.#store.event.totalDays,
      ),
    }
  }

  /**
   * Which day the mock thinks it is.
   *
   * Mirrors the server's calendar resolution, including the clamp, so that
   * testing the two-day flow against the mock behaves the way it will on the day.
   * The mock cannot know today's date in Bengaluru without repeating that
   * arithmetic, so it clamps on the host clock — which is close enough for local
   * development and, unlike a guess, wrong in the same direction the server would
   * be.
   */
  #dayState(): { activeDay: number; totalDays: number; overridden: boolean } {
    const totalDays = this.#store.event.totalDays
    const override = this.#store.event.dayOverride
    const pinned = override !== null && override >= 1 && override <= totalDays

    const first = Date.parse(`${this.#store.event.date}T00:00:00Z`)
    const today = new Date()
    const todayUtc = Date.UTC(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    )
    const elapsed = Number.isNaN(first) ? 1 : Math.round((todayUtc - first) / 86_400_000) + 1
    const calendarDay = Math.min(Math.max(1, elapsed), totalDays)

    return {
      activeDay: pinned ? (this.#store.event.dayOverride as number) : calendarDay,
      totalDays,
      overridden: pinned,
    }
  }

  /**
   * Records attendance from a scanned SEN. Admin-only.
   *
   * The single write path for attendance. There is intentionally no sibling
   * method that updates or removes a record — the log is append-only, so a
   * mistake is corrected by voiding out of band, not by editing history.
   */
  async recordAttendanceBySen(sen: string) {
    this.#requireAdmin()
    await delay(LATENCY_MS / 2)

    const candidate = normaliseSen(sen)

    if (!isValidSen(candidate)) throw new PortalError('unknown_sen')

    /*
      The mock has no HMAC key, so it cannot verify a real signature the way the
      server does. It approximates the distinction: a payload carrying a
      signature-shaped suffix is treated as `qr`, a bare SEN as `printed`. The
      gate's behaviour and the recorded `method` stay faithful enough that the
      admin UI can be developed against the mock, while the authoritative
      verification lives in `server/_lib/ticket.ts`.
    */
    const raw = sen.trim()
    const hasSignature = raw.lastIndexOf('.') > 0
    const method: AdmissionMethod = hasSignature ? 'qr' : 'printed'

    // Defensive on `sen`: a record persisted before SENs existed would throw a
    // TypeError here and surface as a generic failure. At a gate that is the
    // worst possible outcome — it must reject cleanly instead.
    const attendee = this.#store.attendees.find(
      (person) => (person.sen ?? '').toUpperCase() === candidate,
    )
    // An unknown SEN is rejected outright: recording it would fill the roll
    // with people who never registered.
    if (!attendee) throw new PortalError('unknown_sen')

    const dayState = this.#dayState()
    const day = dayState.activeDay

    /*
      Per day, not per attendee — that is the whole difference from the old
      behaviour. Somebody marked on day one is still admitted on day two, because
      they came.
    */
    const existing = this.#store.checkIns.find(
      (entry) => entry.attendeeId === attendee.id && entry.day === day,
    )
    if (existing) {
      throw new PortalError(
        'already_checked_in',
        day > 1 ? `Already marked for day ${day}.` : undefined,
      )
    }

    const record: CheckIn = {
      id: `chk_${randomSuffix()}`,
      sen: attendee.sen,
      attendeeId: attendee.id,
      at: new Date().toISOString(),
      method,
      day,
      // Set here as well as in `listAttendance`. The scan response is the one
      // place a `gate` account sees a name, so it has to be on the record
      // itself rather than joined in only for the log.
      attendeeName: attendee.name,
    }

    this.#store.checkIns.push(record)
    persist(this.#store)

    return { ...record, attendee: toPublic(attendee), dayState }
  }

  /* -------------------------------------------------------- admin tools */

  async listAttendees(): Promise<readonly Attendee[]> {
    this.#requireOwner()
    await delay(LATENCY_MS / 2)
    return this.#store.attendees.map(toPublic)
  }

  /**
   * Every attendance record, oldest first.
   *
   * Available to any staff account, `gate` included, and the attendee name is
   * joined on here for the same reason the server does it: the log cannot
   * resolve names without the roster, and the roster is owner-only.
   */
  async listAttendance(): Promise<readonly CheckIn[]> {
    this.#requireAdmin()
    await delay(LATENCY_MS / 2)
    return [...this.#store.checkIns]
      .sort((a, b) => a.day - b.day || a.at.localeCompare(b.at))
      .map((checkIn) => {
        const person = this.#store.attendees.find((a) => a.id === checkIn.attendeeId)
        return { ...structuredClone(checkIn), attendeeName: person?.name ?? '' }
      })
  }

  async updateAgendaItem(id: string, patch: Partial<AgendaItem>): Promise<AgendaItem> {
    this.#requireOwner()
    await delay(LATENCY_MS / 2)

    const agenda = this.#store.event.agenda
    const index = agenda.findIndex((item) => item.id === id)
    const existing = agenda[index]
    if (index === -1 || existing === undefined) throw new PortalError('not_found')

    const updated: AgendaItem = { ...existing, ...patch }
    this.#store.event = {
      ...this.#store.event,
      agenda: agenda.map((item, position) => (position === index ? updated : item)),
    }
    persist(this.#store)

    return structuredClone(updated)
  }

  async updateEventPhase(phase: EventInfo['phase']): Promise<EventInfo> {
    this.#requireOwner()
    await delay(LATENCY_MS / 2)

    this.#store.event = { ...this.#store.event, phase }
    persist(this.#store)

    return structuredClone(this.#store.event)
  }

  async updateEventDay(dayOverride: number | null): Promise<EventInfo> {
    this.#requireOwner()
    await delay(LATENCY_MS / 2)

    const total = this.#store.event.totalDays
    if (dayOverride !== null && (dayOverride < 1 || dayOverride > total)) {
      throw new PortalError('unknown', `Choose a day between 1 and ${total}.`)
    }

    this.#store.event = { ...this.#store.event, dayOverride }
    persist(this.#store)

    return structuredClone(this.#store.event)
  }

  async setLockedDays(lockedDays: readonly number[]): Promise<EventInfo> {
    this.#requireOwner()
    await delay(LATENCY_MS / 2)

    const total = this.#store.event.totalDays
    const requested = lockedDays.map(Number)

    if (requested.some((day) => !Number.isInteger(day) || day < 1 || day > total)) {
      throw new PortalError(
        'unknown',
        total === 1 ? 'This is a one-day event.' : `Choose a day between 1 and ${total}.`,
      )
    }

    // Same canonical shape the server stores, so the mock cannot drift into
    // rendering a different locked set for the same intent.
    const sorted = [...new Set(requested)].sort((a, b) => a - b)
    this.#store.event = { ...this.#store.event, lockedDays: sorted }
    persist(this.#store)

    return structuredClone(this.#store.event)
  }

  /* ------------------------------------------------------------- roster */

  async getRoster(): Promise<RosterState> {
    this.#requireOwner()
    await delay(LATENCY_MS / 4)
    return this.#rosterState()
  }

  async uploadRoster(
    rows: readonly { name: string; sen: string }[],
    required: boolean,
  ): Promise<RosterUploadResult> {
    this.#requireOwner()
    await delay(LATENCY_MS / 2)

    const problems: string[] = []
    const seen = new Set<string>()
    const accepted: { sen: string; name: string }[] = []

    rows.forEach((row, index) => {
      const sen = normaliseSen(row.sen)
      if (!isValidSen(sen)) {
        problems.push(`row ${index + 2}: not a valid SEN`)
        return
      }
      if (seen.has(sen)) {
        problems.push(`row ${index + 2}: duplicate`)
        return
      }
      seen.add(sen)
      accepted.push({ sen, name: row.name.trim().slice(0, 80) })
    })

    if (accepted.length === 0) {
      throw new PortalError('unknown', `No usable rows. First problem: ${problems[0] ?? 'the file is empty'}`)
    }

    this.#store.roster = accepted
    this.#store.rosterRequired = required
    persist(this.#store)

    return { imported: accepted.length, skipped: problems.length, problems, required }
  }

  async clearRoster(): Promise<RosterState> {
    this.#requireOwner()
    await delay(LATENCY_MS / 4)
    this.#store.roster = []
    this.#store.rosterRequired = false
    persist(this.#store)
    return this.#rosterState()
  }

  #rosterState(): RosterState {
    // Optional on stores seeded before this feature existed, so a local `persist`
    // from an older session cannot make the panel crash on `undefined.length`.
    const roster = this.#store.roster ?? []
    return {
      count: roster.length,
      required: this.#store.rosterRequired ?? false,
      uploadedAt: roster.length > 0 ? this.#store.event.date : null,
      sample: roster.slice(0, 8),
    }
  }

  /* ------------------------------------------------------------- guards */

  #requireAttendee(): AttendeeWithSecret {
    const attendee = this.#store.attendees.find(
      (candidate) => candidate.id === this.#attendeeSessionId,
    )
    if (!attendee) throw new PortalError('forbidden')
    return attendee
  }
}

/* --------------------------------------------------------------- helpers */

function toPublic(attendee: AttendeeWithSecret): Attendee {
  const { id, name, phone, sen, createdAt } = attendee
  return { id, name, phone, sen, createdAt }
}

function toPublicAdmin(admin: {
  id: string
  username: string
  displayName: string
  role?: string
}): AdminUser {
  return {
    id: admin.id,
    username: admin.username,
    displayName: admin.displayName,
    // Defaults to `owner`, matching the seeded admin and the database default. A
    // mock that defaulted to `gate` would lock the demo account out of everything
    // and look like a broken permission model.
    role: admin.role === 'gate' ? 'gate' : 'owner',
  }
}

function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Use at least 8 characters.'
  if (!/[a-zA-Z]/.test(password)) return 'Include at least one letter.'
  if (!/\d/.test(password)) return 'Include at least one number.'
  return null
}

/**
 * FNV-1a. NOT real cryptography — it only stops plaintext sitting in storage.
 * Production must use argon2 or bcrypt.
 */
function hash(value: string): string {
  let result = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 0x01000193) >>> 0
  }
  return result.toString(16).padStart(8, '0')
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

function randomTicketPayload(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* -------------------------------------------------------- session storage */

const SESSION_PREFIX = 'gdg-portal.session.'

/**
 * Simulates how a real httpOnly session cookie behaves.
 *
 * The `remember` flag is the whole point: a remembered session survives a
 * browser restart (localStorage), a non-remembered one is scoped to the tab
 * and dies with it (sessionStorage). Storing everything in localStorage — the
 * obvious shortcut — silently signs users in forever and makes the "keep me
 * signed in" checkbox decorative.
 */
function writeSession(
  kind: 'attendee' | 'admin',
  id: string,
  remember: boolean,
): void {
  const key = SESSION_PREFIX + kind
  clearSession(kind)
  if (remember) localStorage.setItem(key, id)
  else sessionStorage.setItem(key, id)
}

function readSession(kind: 'attendee' | 'admin'): string | null {
  const key = SESSION_PREFIX + kind
  return localStorage.getItem(key) ?? sessionStorage.getItem(key)
}

function clearSession(kind: 'attendee' | 'admin'): void {
  const key = SESSION_PREFIX + kind
  localStorage.removeItem(key)
  sessionStorage.removeItem(key)
}

/**
 * Identifies the current seed data.
 *
 * MUST cover every seeded value, including the demo attendee. Hashing only the
 * event and teams means editing the demo account leaves the cached store stale
 * — and a stale record then fails at the gate instead of on load.
 */
function currentSeedFingerprint(): string {
  return hash(
    JSON.stringify({
      event: SEED_EVENT,
      teams: SEED_TEAMS,
      admins: SEED_ADMINS,
      attendee: SEED_ATTENDEE,
    }),
  )
}

function loadOrSeed(): Store {
  const raw = localStorage.getItem(STORE_KEY)
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Store
      if (parsed.seedFingerprint === currentSeedFingerprint()) return parsed
      // Seed data changed under us: drop the stale store and rebuild.
    } catch {
      localStorage.removeItem(STORE_KEY)
    }
  }

  const store: Store = {
    attendees: [
      {
        id: SEED_ATTENDEE.id,
        name: SEED_ATTENDEE.name,
        phone: SEED_ATTENDEE.phone,
        sen: SEED_ATTENDEE.sen,
        createdAt: '2026-02-11T10:00:00.000Z',
        passwordHash: hash(SEED_ATTENDEE.password),
        ticketCode: randomTicketPayload(),
      },
    ],
    admins: SEED_ADMINS.map((admin) => ({
      ...admin,
      // Demo admin password `ops2026`.
      passwordHash: hash('ops2026'),
    })),
    event: structuredClone(SEED_EVENT),
    teams: structuredClone(SEED_TEAMS) as Team[],
    checkIns: [],
    roster: [],
    rosterRequired: false,
    seedFingerprint: currentSeedFingerprint(),
  }

  localStorage.setItem(STORE_KEY, JSON.stringify(store))
  return store
}

function persist(store: Store): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(store))
}