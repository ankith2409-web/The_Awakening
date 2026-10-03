import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useAdmin, type AdminContextValue } from '@/auth/contexts'
import { stagger } from '@/lib/motion'
import { normaliseSen } from '@/domain/phone'
import { downloadAttendanceCsv } from '@/lib/exportAttendance'
import { BarcodeScanner } from '@/components/BarcodeScanner'
import { Button } from '@/components/Button'
import { Alert, SectionLabel } from '@/components/Typography'
import { EventMark } from '@/components/EventMark'
import { Skeleton } from '@/components/Skeleton'
import { formatPhone } from '@/domain/phone'
import type { AdmissionMethod, AgendaItem, EventPhase, Team } from '@/domain/types'

/**
 * How each attendance row was authenticated at the gate.
 *
 * `qr` means the pass's HMAC signature verified against the server key, so it
 * was genuinely issued by us for that SEN. `printed` means a bare SEN — typed
 * by staff, or read off a printed barcode — where no signature exists and the
 * admission rests on staff judgement.
 *
 * Showing this is not decoration: it tells staff, at a glance, which admissions
 * were self-verified by the system and which they vouched for themselves.
 */
const ADMISSION_LABEL: Record<AdmissionMethod, string> = {
  qr: 'QR · verified',
  printed: 'Typed SEN',
}

const ADMISSION_HINT: Record<AdmissionMethod, string> = {
  qr: 'Scanned pass whose signature verified against the server key.',
  printed: 'Bare SEN with no signature — typed by staff or read from a printed barcode.',
}

type Tab = 'scan' | 'attendance' | 'teams' | 'programme'

const TABS: { id: Tab; label: string }[] = [
  { id: 'scan', label: 'Scan' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'teams', label: 'Teams' },
  { id: 'programme', label: 'Programme' },
]

const PHASES: EventPhase[] = ['registration', 'live', 'completed']
const AGENDA_STATUSES: AgendaItem['status'][] = ['done', 'live', 'upcoming']

export function AdminPortalView() {
  const {
    admin,
    attendees,
    attendance,
    teams,
    event,
    loadingData,
    scanning,
    error,
    lastScan,
    logout,
    refresh,
    scanAttendance,
    setEventPhase,
    setAgendaStatus,
    clearError,
    clearLastScan,
  } = useAdmin()

  const [tab, setTab] = useState<Tab>('scan')

  /*
    No auto-dismiss for the scan confirmation.

    It used to clear itself after three seconds, which is short enough to
    disappear before an operator has finished reading the name back to the
    person in front of them — and the confirmation is only useful if it is read.
    It now persists until the next scan replaces it, or the operator closes it.
  */

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b-4 border-swiss-ink bg-swiss-paper px-4 py-4 sm:gap-4 sm:px-10 lg:px-14">
        <EventMark />

        <div className="flex items-center gap-3 sm:gap-4">
          <span className="hidden border-2 border-swiss-accent-text px-3 py-1 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-accent-text sm:block">
            Operations
          </span>
          <div className="hidden text-right sm:block">
            <p className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
              Signed in
            </p>
            <p className="text-sm font-black tracking-tight text-swiss-ink">
              {admin?.displayName ?? 'Staff'}
            </p>
          </div>
          <Button variant="secondary" size="md" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="px-6 py-10 sm:px-10 lg:px-14">
        <div className="mx-auto max-w-[92rem]">
          <SectionLabel index="05.">Admin Portal</SectionLabel>
          <h1 className="mt-4 text-6xl font-black uppercase leading-[0.88] tracking-tighter text-swiss-ink">
            Control
            <br />
            Room
          </h1>

          <div
            role="tablist"
            aria-label="Admin sections"
            className="mt-10 flex flex-wrap gap-px border-2 border-swiss-ink bg-swiss-ink"
          >
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`tab-${item.id}`}
                aria-selected={tab === item.id}
                aria-controls={`tabpanel-${item.id}`}
                onClick={() => setTab(item.id)}
                className={[
                  'min-h-11 flex-1 cursor-pointer px-5 py-3',
                  'text-2xs font-bold uppercase tracking-[0.2em]',
                  'transition-colors duration-150 ease-linear',
                  tab === item.id
                    ? 'bg-swiss-accent-text text-swiss-paper'
                    : 'bg-swiss-paper text-swiss-ink hover:bg-swiss-muted',
                ].join(' ')}
              >
                {item.label}
              </button>
            ))}
          </div>

          {error ? (
            <div className="mt-6 max-w-md">
              <Alert>{error.message}</Alert>
            </div>
          ) : null}

          {/*
            `scroll-mt` clears the sticky masthead. Without it, scrolling to
            this region tucks the first panel underneath the header, where it
            is invisible but still interactive.
          */}
          <div
            id={`tabpanel-${tab}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            tabIndex={0}
            /*
              The panel cross-fades on tab change, so swapping sections is
              legible rather than instantaneous.

              EXCEPT the scan panel, which is deliberately excluded. It is what a
              volunteer uses at a busy door, usually on a phone, with the camera
              preview and an on-screen keyboard in play; a fade here reads as lag
              and competes with the one interaction that must stay fast.
            */
            className={
              tab === 'scan'
                ? 'mt-8 scroll-mt-28'
                : 'motion-tab-panel mt-8 scroll-mt-28'
            }
          >
            {tab === 'scan' ? (
              <ScanPanel
              scanning={scanning}
              lastScan={lastScan}
              onScan={scanAttendance}
              onDismissScan={clearLastScan}
            />
            ) : null}

            {tab === 'attendance' ? (
              <AttendanceLog
                records={attendance}
                attendees={attendees}
                loading={loadingData}
                eventName={event?.name ?? 'event'}
              />
            ) : null}

            {tab === 'teams' ? <TeamsList teams={teams} loading={loadingData} /> : null}

            {tab === 'programme' ? (
              <ProgrammePanel
                event={event}
                loading={loadingData}
                onPhaseChange={(phase) => void setEventPhase(phase)}
                onStatusChange={(id, status) => void setAgendaStatus(id, status)}
              />
            ) : null}
          </div>

          <div className="mt-10 flex flex-wrap justify-end gap-3">
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                clearError()
                void refresh()
              }}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={attendance.length === 0}
              onClick={() =>
                downloadAttendanceCsv(attendance, event?.name ?? 'event')
              }
            >
              Export SEN ({attendance.length})
            </Button>
          </div>
        </div>
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------- scan */

/**
 * The gate scanner.
 *
 * Two input paths, one outcome. The camera is what staff will actually use; the
 * field exists for a printed barcode that will not scan, and for a USB gun,
 * which behaves exactly like fast typing followed by Enter.
 *
 * Focus is deliberately NOT returned to the SEN field after a camera scan.
 * Returning it there popped the on-screen keyboard over the camera preview on
 * a phone, so the gate operator lost the view they were scanning with and had
 * to dismiss the keyboard before the next badge. Focus returns only after a
 * typed entry, where it genuinely helps — the next code goes straight in.
 *
 * There is no edit and no delete anywhere in this panel. A record is written
 * by a scan and that is the only thing that can create one.
 */
function ScanPanel({
  scanning,
  lastScan,
  onScan,
  onDismissScan,
}: {
  scanning: boolean
  lastScan: AdminContextValue['lastScan']
  onScan: (sen: string) => Promise<{ name: string; sen: string; at: string } | null>
  onDismissScan: () => void
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the field on mount so a USB gun or a typed entry needs no click.
  // Done in an effect rather than `autoFocus` so the browser can finish
  // rendering first, and so the intent is explicit.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /**
   * Records one scan and clears the field, whichever way it arrived.
   *
   * `restoreFocus` is false for camera scans — see the note above the component.
   */
  const record = useCallback(
    async (raw: string, restoreFocus: boolean) => {
      const sen = raw.trim()
      if (sen === '' || scanning) return
      setValue('')
      await onScan(sen)
      if (restoreFocus) inputRef.current?.focus()
    },
    [onScan, scanning],
  )

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await record(value, true)
  }

  return (
    <section className="border-2 border-swiss-ink">
      <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
        Scan Attendance
      </h2>

      <div className="flex flex-col gap-6 p-6 lg:flex-row">
        {/* Camera first: it is what staff will actually use at the gate. */}
        <div className="lg:w-1/2">
          <BarcodeScanner
            onDetect={(text) => void record(text, false)}
            disabled={scanning}
          />
        </div>

        <div className="flex flex-col gap-4 lg:w-1/2">
          {lastScan ? <ScanConfirmation scan={lastScan} onDismiss={onDismissScan} /> : null}

          <p className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted">
            Or type the SEN
          </p>

          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-4 sm:flex-row sm:items-start"
          >
            <label className="flex flex-1 flex-col gap-2">
              <span className="sr-only">SEN</span>
              <input
                ref={inputRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                // Hardware scanners emit Enter; so does autofill and dictation.
                autoComplete="off"
                spellCheck={false}
                aria-describedby="scan-hint"
                className="h-16 w-full border-2 border-swiss-ink bg-swiss-paper px-4 font-mono text-lg font-bold uppercase tracking-[0.1em] text-swiss-ink placeholder:text-sm placeholder:font-medium placeholder:normal-case placeholder:tracking-normal placeholder:text-neutral-400 focus:border-swiss-accent-text focus:outline-none"
              />
            </label>
            <Button type="submit" variant="accent" size="lg" loading={scanning}>
              Mark
            </Button>
          </form>

          <p
            id="scan-hint"
            className="text-2xs font-medium leading-relaxed text-content-muted"
          >
            A record is written only by a scan. Nothing here can be edited or
            deleted — a mistake is corrected by a fresh scan.
          </p>
        </div>
      </div>
    </section>
  )
}

/**
 * Confirmation that one badge was accepted.
 *
 * Shows the attendee's name at a size readable from arm's length, because the
 * gate operator has to check it against the person in front of them and then
 * say it back. The SEN and the admission method sit underneath as audit detail:
 * "pass verified" means the QR signature checked out, "typed SEN" means staff
 * vouched for it by hand, and that distinction is the answer to "how did this
 * person get in".
 *
 * Deliberately NOT the red error banner. Red is reserved for failure, so a
 * success in red would make a working gate look broken. This is ink on paper.
 *
 * It does not auto-dismiss. A confirmation that vanishes before the operator
 * has read the name defeats the purpose; the next scan replaces it, and the
 * close button is there for a queue that has gone quiet.
 */
function ScanConfirmation({
  scan,
  onDismiss,
}: {
  scan: NonNullable<AdminContextValue['lastScan']>
  onDismiss: () => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-2 border-swiss-ink"
    >
      <div className="flex items-center justify-between gap-4 border-b-2 border-swiss-ink bg-swiss-ink px-4 py-2">
        <span className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
          Marked
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss confirmation"
          className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-paper transition-opacity duration-150 ease-linear hover:opacity-70"
        >
          Close
        </button>
      </div>

      <div className="p-4">
        <p className="text-3xl font-black uppercase leading-none tracking-tight text-swiss-ink">
          {scan.name}
        </p>

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-2xs">
          <dt className="font-bold uppercase tracking-[0.2em] text-content-muted">
            SEN
          </dt>
          <dd className="font-mono font-bold tracking-[0.1em] text-swiss-ink">
            {scan.sen}
          </dd>

          <dt className="font-bold uppercase tracking-[0.2em] text-content-muted">
            Via
          </dt>
          <dd className="font-bold uppercase tracking-[0.15em] text-swiss-ink">
            {scan.method === 'qr' ? 'Pass verified' : 'Typed SEN, no signature'}
          </dd>
        </dl>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- attendance */

function AttendanceLog({
  records,
  attendees,
  loading,
  eventName,
}: {
  records: ReturnType<typeof useAdmin>['attendance']
  attendees: ReturnType<typeof useAdmin>['attendees']
  loading: boolean
  eventName: string
}) {
  const [query, setQuery] = useState('')
  const byId = useMemo(
    () => new Map(attendees.map((person) => [person.id, person])),
    [attendees],
  )

  const filtered = useMemo(() => {
    const needle = normaliseSen(query)
    if (needle === '') return records
    return records.filter((record) => record.sen.includes(needle))
  }, [records, query])

  if (loading) return <Skeleton className="h-64 w-full" />

  return (
    <section className="border-2 border-swiss-ink">
      <div className="flex flex-col gap-4 border-b-2 border-swiss-ink bg-swiss-ink px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
          Attendance Log
        </h2>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by SEN"
          aria-label="Filter attendance by SEN"
          className="h-10 w-full border-2 border-swiss-paper bg-transparent px-3 font-mono text-sm text-swiss-paper placeholder:font-sans placeholder:text-content-muted/80 focus:border-swiss-accent-on-dark focus:outline-none sm:w-64"
        />
      </div>

      {filtered.length === 0 ? (
        <p
          role="status"
          className="p-6 text-2xs font-bold uppercase tracking-[0.2em] text-content-muted"
        >
          No attendance recorded yet
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-swiss-ink">
                  {['#', 'SEN', 'Name', 'Phone', 'Time', 'Gate', 'Via'].map((head) => (
                    <th
                      key={head}
                      scope="col"
                      className="px-4 py-3 text-2xs font-bold uppercase tracking-[0.2em] text-content-muted"
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((record, index) => {
                  const person = byId.get(record.attendeeId)
                  return (
                    <tr
                      key={record.id}
                      style={stagger(index)}
                      className="motion-stagger border-b border-swiss-ink/15 last:border-b-0"
                    >
                      <td className="px-4 py-3 font-mono text-2xs text-content-muted">
                        {index + 1}
                      </td>
                      <th
                        scope="row"
                        className="px-4 py-3 font-mono text-sm font-bold text-swiss-ink"
                      >
                        {record.sen}
                      </th>
                      <td className="px-4 py-3 text-sm font-bold tracking-tight text-swiss-ink">
                        {person?.name ?? '—'}
                      </td>
                      <td className="px-4 py-3 font-mono text-2xs text-content-muted">
                        {person ? formatPhone(person.phone) : '—'}
                      </td>
                      <td className="px-4 py-3 font-mono text-2xs text-content-muted">
                        {new Date(record.at).toLocaleTimeString('en-GB', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="px-4 py-3 text-2xs font-bold uppercase tracking-[0.15em] text-swiss-accent-text">
                        {record.gate}
                      </td>
                      <td className="px-4 py-3 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                        {/*
                          `qr` = the pass's signature verified, so it was
                          issued by us. `printed` = a bare SEN with no
                          signature, i.e. typed or read off paper. Surfaced so
                          staff can see which admissions were self-verified.
                        */}
                        <span title={ADMISSION_HINT[record.method]}>
                          {ADMISSION_LABEL[record.method]}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <ul className="flex flex-col md:hidden">
            {filtered.map((record, index) => {
              const person = byId.get(record.attendeeId)
              return (
                <li
                  key={record.id}
                  style={stagger(index)}
                  className="motion-stagger border-b border-swiss-ink/15 p-4 last:border-b-0"
                >
                  <p className="font-mono text-sm font-bold text-swiss-ink">
                    {record.sen}
                  </p>
                  <p className="mt-1 text-sm font-bold tracking-tight text-swiss-ink">
                    {person?.name ?? '—'}
                  </p>
                  <p className="mt-1 font-mono text-2xs text-content-muted">
                    {new Date(record.at).toLocaleTimeString('en-GB', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    · {record.gate}
                  </p>
                  <p className="mt-1 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                    {ADMISSION_LABEL[record.method]}
                  </p>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <p className="border-t-2 border-swiss-ink px-6 py-4 text-2xs font-medium text-content-muted">
        Export produces one SEN per row for{' '}
        <span className="font-bold uppercase tracking-[0.15em] text-swiss-ink">
          {eventName}
        </span>
        .
      </p>
    </section>
  )
}

/* ------------------------------------------------------------------ teams */

/**
 * Teams, read-only: name, lead, members.
 *
 * Teams are an organiser concern and are not shown on the attendee dashboard.
 */
function TeamsList({
  teams,
  loading,
}: {
  teams: readonly Team[]
  loading: boolean
}) {
  if (loading) return <Skeleton className="h-64 w-full" />

  if (teams.length === 0) {
    return (
      <p
        role="status"
        className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted"
      >
        No teams configured
      </p>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
      {teams.map((team) => (
        <section key={team.id} className="flex flex-col border-2 border-swiss-ink">
          <header className="border-b-2 border-swiss-ink bg-swiss-ink px-5 py-3">
            <h2 className="text-lg font-black uppercase leading-none tracking-tight text-swiss-paper">
              {team.name}
            </h2>
          </header>

          <div className="p-5">
            <p className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted">
              Lead
            </p>
            <p className="mt-1 text-base font-black tracking-tight text-swiss-ink">
              {team.leadName}
            </p>
          </div>

          <div className="border-t-2 border-swiss-ink p-5">
            <p className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted">
              Members — {team.members.length}
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              {team.members.map((member) => (
                <li
                  key={member}
                  className="flex items-center gap-3 border-b border-swiss-ink/15 pb-2 text-sm font-medium text-swiss-ink last:border-b-0"
                >
                  <span aria-hidden="true" className="size-2 shrink-0 bg-swiss-accent" />
                  {member}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------- programme */

function ProgrammePanel({
  event,
  loading,
  onPhaseChange,
  onStatusChange,
}: {
  event: ReturnType<typeof useAdmin>['event']
  loading: boolean
  onPhaseChange: (phase: EventPhase) => void
  onStatusChange: (id: string, status: AgendaItem['status']) => void
}) {
  if (loading) return <Skeleton className="h-64 w-full" />

  if (!event) {
    return (
      <p
        role="status"
        className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted"
      >
        Programme unavailable
      </p>
    )
  }

  // Only mark day boundaries when the programme genuinely spans more than one
  // day; on a single-day schedule it would be pure noise.
  const agendaDays = new Set(event.agenda.map((item) => item.day ?? 1)).size

  return (
    <div className="flex flex-col gap-8">
      <section className="border-2 border-swiss-ink">
        <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
          Event Phase
        </h2>
        <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
          <p className="flex-1 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
            Drives what attendees see on their dashboard.
          </p>
          <div className="flex gap-px bg-swiss-ink">
            {PHASES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onPhaseChange(option)}
                aria-pressed={event.phase === option}
                className={[
                  'min-h-11 cursor-pointer px-4 py-2',
                  'text-2xs font-bold uppercase tracking-[0.2em]',
                  'transition-colors duration-150 ease-linear',
                  event.phase === option
                    ? 'bg-swiss-accent-text text-swiss-paper'
                    : 'bg-swiss-paper text-swiss-ink hover:bg-swiss-muted',
                ].join(' ')}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="border-2 border-swiss-ink">
        <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
          Agenda Control
        </h2>
        <ul className="flex flex-col">
          {event.agenda.map((item, index) => {
            const day = item.day ?? 1
            const previousDay = index > 0 ? (event.agenda[index - 1]?.day ?? 1) : null
            const startsNewDay = previousDay !== null && previousDay !== day
            return (
              <li
                key={item.id}
                className={[
                  'flex flex-col gap-3 p-4 sm:flex-row sm:items-center',
                  index > 0 && !startsNewDay ? 'border-t border-swiss-ink/15' : '',
                  // A heavier rule where the programme rolls over to the next
                  // day, so the split is visible at a glance.
                  startsNewDay ? 'border-t-2 border-swiss-ink' : '',
                ].join(' ')}
              >
                <div className="flex w-14 shrink-0 flex-col">
                  <time className="font-mono text-2xs font-bold text-swiss-ink">
                    {item.startsAt}
                  </time>
                  {agendaDays > 1 ? (
                    <span className="font-mono text-2xs text-content-muted">D{day}</span>
                  ) : null}
                </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold tracking-tight text-swiss-ink">
                  {item.title}
                </p>
                <p className="mt-0.5 text-2xs text-content-muted">
                  {item.speaker} · {item.room}
                </p>
              </div>
              <div className="flex gap-px bg-swiss-ink">
                {AGENDA_STATUSES.map((status) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => onStatusChange(item.id, status)}
                    aria-pressed={item.status === status}
                    className={[
                      'min-h-11 cursor-pointer px-3 py-1.5',
                      'text-2xs font-bold uppercase tracking-[0.15em]',
                      'transition-colors duration-150 ease-linear',
                      item.status === status
                        ? 'bg-swiss-accent-text text-swiss-paper'
                        : 'bg-swiss-paper text-swiss-ink hover:bg-swiss-muted',
                    ].join(' ')}
                  >
                    {status}
                  </button>
                ))}
              </div>
            </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
