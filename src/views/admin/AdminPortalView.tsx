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
import { AttendeeDirectory } from './AttendeeDirectory'
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

type Tab = 'scan' | 'attendance' | 'desk' | 'teams' | 'programme'

/**
 * The tabs, and who may see each one.
 *
 * `gate` is whoever is on the door: scan a badge, look at the log, look at teams.
 * Nothing else. `owner` additionally gets the Desk (changing somebody's
 * credential is not a door-side job) and the Programme.
 *
 * The role is read from the session to decide what to DRAW. It is not what
 * decides what is ALLOWED — every one of these routes checks the role again on
 * the server, because this value arrives in a cookie and a volunteer with a
 * modified browser is not a hypothetical.
 *
 * `desk` sits third, immediately after attendance. The two are one workflow:
 * someone comes to the door and staff check them in; someone else comes to the
 * door and staff fix their password.
 */
const TABS: { id: Tab; label: string; ownerOnly: boolean }[] = [
  { id: 'scan', label: 'Scan', ownerOnly: false },
  { id: 'attendance', label: 'Attendance', ownerOnly: false },
  { id: 'desk', label: 'Desk', ownerOnly: true },
  { id: 'teams', label: 'Teams', ownerOnly: false },
  { id: 'programme', label: 'Programme', ownerOnly: true },
]

const PHASES: EventPhase[] = ['registration', 'live', 'completed']
const AGENDA_STATUSES: AgendaItem['status'][] = ['done', 'live', 'upcoming']

export function AdminPortalView() {
  const {
    admin,
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
    updateEventDay,
    setLockedDays,
    clearError,
    clearLastScan,
  } = useAdmin()

  const [tab, setTab] = useState<Tab>('scan')

  /*
    Which day's attendance is being looked at — and exported.

    ONE control for both, deliberately. There were two: a Day / All days switch in
    the log header and a separate select beside the export button, and they could
    disagree. Reading the log for day one and then exporting "day two" because the
    other control still said day two is precisely the silent mistake the per-day
    work was meant to prevent.

    So there is a single selection, always visible in the page's action row, and
    both the log and the export follow it. No "all days": the question "who was
    here" is asked about one day at a time, and a combined view invites reading it
    as a total when it is two lists.

    Defaults to the active day and follows it, so on the evening of day one
    "today" is already selected and nothing has to be chosen by hand.
  */
  const [viewDay, setViewDay] = useState<number | null>(null)
  const totalDays = event?.totalDays ?? 1
  const activeDay = event?.activeDay ?? 1
  const selectedDay = viewDay ?? activeDay
  const lockedDays = event?.lockedDays ?? []
  // Whether the LIVE day is closed, which is what actually stops a scan. Distinct
  // from whether the day being *viewed* is closed, which stops nothing.
  const activeDayLocked = lockedDays.includes(activeDay)
  const dayRecords = useMemo(
    () => attendance.filter((record) => record.day === selectedDay),
    [attendance, selectedDay],
  )

  /*
    Fails SAFE: an unknown or missing role is treated as the narrower one.

    If the server ever sends a role this build does not recognise — a third value
    added by a later deploy, a stale bundle against a newer API — the correct
    behaviour is to show a volunteer three tabs, not to show a stranger the Staff
    panel. Widening by accident is unrecoverable; narrowing is merely annoying.
  */
  const isOwner = admin?.role === 'owner'
  const visibleTabs = TABS.filter((item) => isOwner || !item.ownerOnly)

  /*
    Guards against being stranded on a tab this role cannot see.

    `tab` is state that outlives a role change: a signed-in owner who is
    demoted elsewhere keeps their session cookie, the session probe re-reads the
    row, and the panel comes back as `gate`. Without this the Desk or Staff panel
    would stay on screen, rendering an empty roster and a 403 on every action.
  */
  const activeTab = visibleTabs.some((item) => item.id === tab) ? tab : 'scan'

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
            {/*
              "Operating as", not "Signed in".

              Two reasons. The house rule is "Log in", never "Sign in", and this
              masthead had been the one place that broke it. But the label was also
              wrong on its own terms: it described a session state rather than
              saying whose session this is, which is the thing somebody at a desk
              with a shared credential actually needs to know before they act.
            */}
            <p className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
              Operating as
            </p>
            <p className="text-sm font-black tracking-tight text-swiss-ink">
              {admin?.displayName ?? 'Staff'}
            </p>
          </div>
          <Button variant="secondary" size="md" onClick={() => void logout()}>
            Log out
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
            {visibleTabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`tab-${item.id}`}
                aria-selected={activeTab === item.id}
                aria-controls={`tabpanel-${item.id}`}
                onClick={() => setTab(item.id)}
                className={[
                  'min-h-11 flex-1 cursor-pointer px-5 py-3',
                  'text-2xs font-bold uppercase tracking-[0.2em]',
                  'transition-colors duration-150 ease-linear',
                  activeTab === item.id
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
            id={`tabpanel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`tab-${activeTab}`}
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
              activeTab === 'scan'
                ? 'mt-8 scroll-mt-28'
                : 'motion-tab-panel mt-8 scroll-mt-28'
            }
          >
            {activeTab === 'scan' ? (
              <ScanPanel
              scanning={scanning}
              lastScan={lastScan}
              activeDay={activeDay}
              totalDays={totalDays}
              overridden={event?.dayOverridden ?? false}
              viewingDay={selectedDay}
              isOwner={isOwner}
              activeDayLocked={activeDayLocked}
              onScan={scanAttendance}
              /*
                Follow the record, not the operator's earlier choice.

                Only ever called on a successful scan, and only ever moves the view
                to where that record actually is. In normal operation the two days
                already match and this is a no-op; it only does anything in the case
                that read as a broken scanner.
              */
              onRecorded={setViewDay}
              onDismissScan={clearLastScan}
            />
            ) : null}

            {/*
              The log no longer takes the roster. It shows `attendeeName` off each
              row, which the server joins in, so a `gate` account sees real names
              without ever being sent the roster it would need to resolve them.
            */}
            {activeTab === 'attendance' ? (
              <AttendanceLog
                records={dayRecords}
                loading={loadingData}
                eventName={event?.name ?? 'event'}
                canExport={isOwner}
                day={selectedDay}
                totalDays={totalDays}
              />
            ) : null}

            {activeTab === 'desk' ? <AttendeeDirectory /> : null}

            {activeTab === 'teams' ? <TeamsList teams={teams} loading={loadingData} /> : null}

            {activeTab === 'programme' ? (
              <ProgrammePanel
                event={event}
                loading={loadingData}
                onPhaseChange={(phase) => void setEventPhase(phase)}
                onDayChange={(day) => void updateEventDay(day)}
              onLockedDaysChange={(days) => void setLockedDays(days)}
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
            {/*
              Owner-only.

              This is the SEN export, and it is the one control a `gate` account
              must not have. It is client-side, so hiding the button is genuinely
              all the UI can do — which is worth being honest about: a volunteer
              who can read the attendance log already sees every marked SEN on
              screen and could write them down. Letting them have the log and
              forbidding the export is a speed bump, not a wall. The wall is that
              `/admin/attendees` is refused, so the roster of everyone who has
              *not* arrived never reaches their device at all.
            */}
            {/*
              One day selector, governing the log above and the export beside it.

              Placed here rather than inside the log header because it is visible
              from every tab — an owner who wants day one exported without first
              opening the log should not have to go and set it somewhere they
              cannot see.

              Not a `<select>`. A segmented pair matches the switch controls used
              everywhere else in this portal, and shows both days at once instead of
              hiding the choice inside a dropdown.
            */}
            {totalDays > 1 ? (
              <div
                role="group"
                aria-label="Which day's attendance to show and export"
                className="flex items-center gap-3"
              >
                <span className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted">
                  Day
                </span>
                <div className="flex gap-px border-2 border-swiss-ink bg-swiss-ink">
                  {Array.from({ length: totalDays }, (_, index) => index + 1).map(
                    (day) => (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={selectedDay === day}
                        onClick={() => setViewDay(day)}
                        className={[
                          'relative min-h-14 cursor-pointer px-5',
                          'text-sm font-bold uppercase tracking-[0.15em]',
                          'transition-colors duration-150 ease-linear',
                          selectedDay === day
                            ? 'bg-swiss-ink text-swiss-paper'
                            : 'bg-swiss-paper text-swiss-ink hover:bg-swiss-muted',
                        ].join(' ')}
                      >
                        {day}
                        {/*
                          A closed day still shows its full attendance — locking
                          stops new marks, it does not hide who came. Marked here so
                          the state is visible from every tab without opening the
                          Programme tab, and readable by a `gate` account that
                          cannot change it.
                        */}
                        {lockedDays.includes(day) ? (
                          <span
                            title={`Attendance is closed for day ${day}`}
                            className="absolute -right-px -top-px size-3 bg-swiss-accent-text"
                            aria-hidden="true"
                          />
                        ) : null}
                        {lockedDays.includes(day) ? (
                          <span className="sr-only">
                            (attendance closed)
                          </span>
                        ) : null}
                      </button>
                    ),
                  )}
                </div>
              </div>
            ) : null}

            {isOwner ? (
              <Button
                variant="primary"
                size="md"
                disabled={dayRecords.length === 0}
                onClick={() =>
                  downloadAttendanceCsv(attendance, event?.name ?? 'event', selectedDay)
                }
              >
                {totalDays > 1
                  ? `Export SEN — day ${selectedDay} (${dayRecords.length})`
                  : `Export SEN (${dayRecords.length})`}
              </Button>
            ) : null}
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
  activeDay,
  totalDays,
  overridden,
  viewingDay,
  isOwner,
  activeDayLocked,
  onScan,
  onRecorded,
  onDismissScan,
}: {
  scanning: boolean
  lastScan: AdminContextValue['lastScan']
  activeDay: number
  totalDays: number
  overridden: boolean
  /** Which day the attendance log and the export are currently showing. */
  viewingDay: number
  /** Owner-only: only an owner can change which day scans record against. */
  isOwner: boolean
  /**
   * Whether the LIVE day is closed for attendance.
   *
   * Stated as a panel state rather than left to the scan error, because a closed
   * day produces one refusal per badge. Somebody running a queue through a closed
   * day would get the same message a dozen times and conclude the scanner was
   * broken — when in fact it is working exactly as configured.
   */
  activeDayLocked: boolean
  onScan: (
    sen: string,
  ) => Promise<{ name: string; sen: string; at: string; day: number } | null>
  /**
   * Called with the day a scan was actually recorded against.
   *
   * This exists because a successful scan could be invisible. The day a mark lands
   * on is decided by the server from the calendar, while the day on screen is an
   * operator choice — so scanning somebody while the log is set to another day put
   * the record somewhere the operator was not looking. It read as a failed scan,
   * which is the one conclusion the confirmation panel directly contradicts.
   *
   * The fix is to follow the record rather than to explain it. Telling somebody
   * where their scan went is weaker than showing them the row it created.
   */
  onRecorded: (day: number) => void
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
      const result = await onScan(sen)
      // Only on success. A rejected SEN records nothing, so there is no day to
      // follow and moving the view would be a lie.
      if (result !== null) onRecorded(result.day)
      if (restoreFocus) inputRef.current?.focus()
    },
    [onScan, onRecorded, scanning],
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

      {/*
        Which day this scan will be recorded against.

        Read-only, because the server decides it from the calendar and there is
        nothing at the door to set. It is on screen anyway, prominently, because
        the operator is the only person who can tell whether that is right: if the
        portal says "Day 1" on the morning of day two, someone standing at the
        door needs to be able to see it and say so, rather than discovering it in
        the export hours later.

        An override is called out because a pinned day is the likeliest reason the
        portal disagrees with the calendar.
      */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b-2 border-swiss-ink px-6 py-4">
        <span className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted">
          Recording for
        </span>
        <span className="text-xl font-black uppercase leading-none tracking-tight text-swiss-ink">
          Day {activeDay}
          <span className="text-sm text-content-muted">
            {' '}
            of {totalDays}
          </span>
        </span>
        {overridden ? (
          <span className="border-2 border-swiss-accent-text px-2 py-0.5 text-2xs font-bold uppercase tracking-[0.15em] text-swiss-accent-text">
            Pinned by an organiser
          </span>
        ) : null}
        {activeDayLocked ? (
          <span className="border-2 border-swiss-accent-text bg-swiss-accent-text px-2 py-0.5 text-2xs font-bold uppercase tracking-[0.15em] text-swiss-paper">
            Closed for attendance
          </span>
        ) : null}
      </div>

      {/*
        The closed state, stated before anybody scans.

        Without this the only signal is the per-scan refusal that follows. Twelve
        people in a queue each get "day 1 is closed", and a volunteer concludes the
        scanner is broken rather than that the day is deliberately shut — the exact
        inverse of what an owner locking a day intends to communicate.

        The scanner is disabled rather than hidden: a control that vanishes is a
        control somebody will go looking for, and the panel still needs to explain
        itself.
      */}
      {activeDayLocked ? (
        <div className="border-b-2 border-swiss-ink bg-swiss-muted px-6 py-5">
          <p className="text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
            Attendance for day {activeDay} is closed
          </p>
          <p className="mt-2 max-w-prose text-2xs font-medium leading-relaxed text-content-muted">
            Nobody can be marked for this day any more, which is what you want once
            its SEN list has gone out. Existing records are untouched — the log and
            the export still show the day in full.
            {isOwner
              ? ' Reopen it on the Programme tab if this was a mistake.'
              : ' Ask an organiser to reopen it if people are still arriving.'}
          </p>
        </div>
      ) : null}

      {/*
        The mismatch warning, and the reason this component knows what the log is
        showing at all.

        Two different questions are being answered on this screen and they are easy
        to conflate. "Which day am I LOOKING at" is the operator's choice, and it
        moves the log and the export. "Which day am I WRITING to" is the server's,
        from the calendar, and there is nothing at the door to set it.

        When they disagree, a scan still succeeds — into the other day — and the
        confirmation panel says so, but the row then does not appear in the log the
        operator is looking at. Reported as "attendance is not marking". So it is
        stated up front, before anyone scans, rather than only explained afterwards.
      */}
      {viewingDay !== activeDay ? (
        <div
          role="status"
          className="border-b-2 border-swiss-accent-text bg-swiss-accent-text px-6 py-3"
        >
          <p className="text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-paper">
            You are viewing day {viewingDay}. Scans are recorded for day {activeDay}
            {/*
              Says what happens rather than leaving it to be discovered: the view
              follows a successful scan, so the record cannot end up off-screen.
            */}
            , and the view will follow any scan you make.
          </p>
          {/*
            Only an owner can change the recording day, so only an owner is told
            where. A `gate` volunteer has no such control and pointing at it would
            send them looking for something that does not exist for them.

            This line exists because the control that DOES change it lives on a
            different tab under a different name — "Attendance Day" on Programme —
            and switching the day here does not touch it. Reported as "attendance is
            not marking" by somebody who had switched to day two expecting to record
            day two.
          */}
          {isOwner ? (
            <p className="mt-2 text-2xs font-medium uppercase leading-relaxed tracking-[0.15em] text-swiss-paper/85">
              To record day {viewingDay} instead, change Attendance Day on the
              Programme tab.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-6 p-6 lg:flex-row">
        {/* Camera first: it is what staff will actually use at the gate. */}
        <div className="lg:w-1/2">
          <BarcodeScanner
            onDetect={(text) => void record(text, false)}
            disabled={scanning || activeDayLocked}
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
                // Disabled, not hidden — a USB scanner types into this field whether
                // or not it is focusable, so the guard has to be here as well as on
                // the button. The server refuses regardless; this stops the queue
                // filling with refusals.
                disabled={activeDayLocked}
                className="h-16 w-full border-2 border-swiss-ink bg-swiss-paper px-4 font-mono text-lg font-bold uppercase tracking-[0.1em] text-swiss-ink placeholder:text-sm placeholder:font-medium placeholder:normal-case placeholder:tracking-normal placeholder:text-neutral-400 focus:border-swiss-accent-text focus:outline-none disabled:cursor-not-allowed disabled:border-content-muted/50 disabled:bg-swiss-muted disabled:text-content-muted/50"
              />
            </label>
            <Button
              type="submit"
              variant="accent"
              size="lg"
              loading={scanning}
              disabled={activeDayLocked}
            >
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
          Marked for day {scan.day}
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

          {/*
            Not shown for a single-day event. "Day 1 of 1" is noise, and it would
            appear on every confirmation at an event that only has one day.
          */}
          {scan.totalDays > 1 ? (
            <>
              <dt className="font-bold uppercase tracking-[0.2em] text-content-muted">
                Day
              </dt>
              <dd className="font-bold uppercase tracking-[0.15em] text-swiss-ink">
                {scan.day} of {scan.totalDays}
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- attendance */

/**
 * The attendance log.
 *
 * Names come off each row (`attendeeName`, joined in by the server) rather than
 * being looked up against the roster. That is not a tidy-up: `/admin/attendees`
 * is owner-only, so a lookup would render this log as a column of dashes for
 * every volunteer who most needs it. Phone is owner-only too and is simply not
 * in the table for that reason.
 */
/**
 * The attendance log, for ONE day.
 *
 * Two days are two lists, not one long one. "Who came today" is the question at a
 * gate, and interleaving both days by clock time buries the answer between
 * yesterday's rows. There is deliberately no "all days" view: the count at the
 * top would then read as a total for the event when it is two separate figures,
 * which is how a number gets quoted that is wrong.
 *
 * Which day is chosen by the page, not here, so the log and the export can never
 * disagree about what is on screen.
 */
function AttendanceLog({
  records,
  loading,
  eventName,
  canExport,
  day,
  totalDays,
}: {
  records: ReturnType<typeof useAdmin>['attendance']
  loading: boolean
  eventName: string
  canExport: boolean
  day: number
  totalDays: number
}) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = normaliseSen(query).toLowerCase()
    if (needle === '') return records
    // Matches the SEN or the name — a volunteer at the door knows one or the
    // other far more often than both.
    return records.filter(
      (record) =>
        record.sen.toLowerCase().includes(needle) ||
        record.attendeeName.toLowerCase().includes(needle),
    )
  }, [records, query])

  if (loading) return <Skeleton className="h-64 w-full" />

  return (
    <section className="border-2 border-swiss-ink">
      <div className="flex flex-col gap-4 border-b-2 border-swiss-ink bg-swiss-ink px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
          Attendance Log
          {/*
            The day is in the panel's own title rather than in a control here.

            It is chosen by the page — the same choice that governs the export —
            so the log cannot be showing day one while the export is set to day
            two. Naming it here means nobody has to look away to know which list
            they are reading.
          */}
          {totalDays > 1 ? (
            <span className="ml-3 text-swiss-accent-on-dark">Day {day}</span>
          ) : null}
        </h2>

        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by SEN or name"
          aria-label="Filter attendance by SEN or name"
          className="h-10 w-full border-2 border-swiss-paper bg-transparent px-3 font-mono text-sm text-swiss-paper placeholder:font-sans placeholder:text-content-muted/80 focus:border-swiss-accent-on-dark focus:outline-none sm:w-64"
        />
      </div>

      {filtered.length === 0 ? (
        <p
          role="status"
          className="p-6 text-2xs font-bold uppercase tracking-[0.2em] text-content-muted"
        >
          {query !== ''
            ? 'No match'
            : totalDays > 1
              ? `Nobody marked for day ${day} yet`
              : 'No attendance recorded yet'}
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-swiss-ink">
                  {/*
                    `Gate` is gone. The column held a hard-coded 'Gate A' for every
                    row in the database — a door that does not exist, shown beside a
                    real venue. There is one entrance, so there is nothing for the
                    column to distinguish.
                  */}
                  {['#', 'SEN', 'Name', 'Time', 'Via'].map((head) => (
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
                {filtered.map((record, index) => (
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
                        {record.attendeeName}
                      </td>
                      <td className="px-4 py-3 font-mono text-2xs text-content-muted">
                        {new Date(record.at).toLocaleTimeString('en-GB', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
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
                ))}
              </tbody>
            </table>
          </div>

          <ul className="flex flex-col md:hidden">
            {filtered.map((record, index) => (
                <li
                  key={record.id}
                  style={stagger(index)}
                  className="motion-stagger border-b border-swiss-ink/15 p-4 last:border-b-0"
                >
                  <p className="font-mono text-sm font-bold text-swiss-ink">
                    {record.sen}
                  </p>
                  <p className="mt-1 text-sm font-bold tracking-tight text-swiss-ink">
                    {record.attendeeName}
                  </p>
                  <p className="mt-1 font-mono text-2xs text-content-muted">
                    {new Date(record.at).toLocaleTimeString('en-GB', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                  <p className="mt-1 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                    {ADMISSION_LABEL[record.method]}
                  </p>
                </li>
            ))}
          </ul>
        </>
      )}

      {/*
        The export is owner-only, so the caption that explains it is too. A
        volunteer being told about an export they cannot perform is worse than
        silence — it invites them to go looking for it.
      */}
      {canExport ? (
        <p className="border-t-2 border-swiss-ink px-6 py-4 text-2xs font-medium text-content-muted">
          Export produces one SEN per row for{' '}
          <span className="font-bold uppercase tracking-[0.15em] text-swiss-ink">
            {eventName}
          </span>
          .
        </p>
      ) : null}
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
  onDayChange,
  onLockedDaysChange,
  onStatusChange,
}: {
  event: ReturnType<typeof useAdmin>['event']
  loading: boolean
  onPhaseChange: (phase: EventPhase) => void
  onDayChange: (day: number | null) => void
  onLockedDaysChange: (days: readonly number[]) => void
  onStatusChange: (id: string, status: AgendaItem['status']) => void
}) {
  const locked = event?.lockedDays ?? []
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

      {/*
        Which day scans are recorded against.

        Normally nothing to do: the server reads it from the calendar, so on the
        morning of day two it says day two by itself and there is no switch at the
        door to forget.

        This control exists for the two cases where the calendar is wrong. Testing
        the day-two flow before it arrives, and a schedule that has slipped — a
        day-two session running at 09:00 on the morning the calendar still calls
        day one. Both are cases where a human knows something the date does not.

        Left on `Auto`, which is where it belongs between events.
      */}
      <section className="border-2 border-swiss-ink">
        <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
          Attendance Day
        </h2>
        <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
          <p className="flex-1 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
            The calendar says day {event.calendarDay} of {event.totalDays}. Auto
            follows it.
          </p>
          <div className="flex gap-px bg-swiss-ink">
            <button
              type="button"
              onClick={() => onDayChange(null)}
              aria-pressed={event.dayOverride === null}
              className={[
                'min-h-11 cursor-pointer px-4 py-2',
                'text-2xs font-bold uppercase tracking-[0.2em]',
                'transition-colors duration-150 ease-linear',
                event.dayOverride === null
                  ? 'bg-swiss-accent-text text-swiss-paper'
                  : 'bg-swiss-paper text-swiss-ink hover:bg-swiss-muted',
              ].join(' ')}
            >
              Auto
            </button>
            {Array.from({ length: event.totalDays }, (_, index) => index + 1).map(
              (day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => onDayChange(day)}
                  aria-pressed={event.dayOverride === day}
                  className={[
                    'min-h-11 cursor-pointer px-4 py-2',
                    'text-2xs font-bold uppercase tracking-[0.2em]',
                    'transition-colors duration-150 ease-linear',
                    event.dayOverride === day
                      ? 'bg-swiss-accent-text text-swiss-paper'
                      : 'bg-swiss-paper text-swiss-ink hover:bg-swiss-muted',
                  ].join(' ')}
                >
                  Day {day}
                </button>
              ),
            )}
          </div>
        </div>
      </section>

      {/*
        Close attendance for a day that is finished.

        A different control from "Attendance Day" above, and deliberately not merged
        into it. That one moves the present forward; this one closes a day behind
        you. They are pressed at opposite moments — one in the morning, one at the
        end — and combining them would mean a single control whose meaning depends
        on when you touched it.

        Why it is needed at all: attendance is append-only, with no edit and no
        delete anywhere in the product. So once a day's SEN list has gone out for
        certificates, a late scan cannot be corrected — the record is wrong forever
        and there is no route that removes it. Locking the day is the only honest
        answer available, and it is a real one: it stops new marks rather than
        pretending an existing one can be amended.

        Locking hides nothing. The log, the roster badges and the SEN export all
        still show the locked day in full; only new marks are refused.

        Sends the whole intended set rather than a toggle, so a retry on a bad
        connection cannot reopen a day the organiser meant to close.
      */}
      <section className="border-2 border-swiss-ink">
        <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
          Close Attendance
        </h2>
        <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
          <p className="flex-1 text-2xs font-medium uppercase leading-relaxed tracking-[0.15em] text-content-muted">
            {locked.length === 0
              ? 'Every day is open. Nobody can be marked on a closed day.'
              : locked.length >= event.totalDays
                ? 'Every day is closed — nobody can be marked at all right now.'
                : `Closed: day ${locked.join(', day ')}. Those days still show in the log and the export.`}
          </p>
          <div className="flex gap-px bg-swiss-ink">
            {Array.from({ length: event.totalDays }, (_, index) => index + 1).map(
              (day) => {
                const isLocked = locked.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    // The state is "closed", so the button says so. A toggle whose
                    // pressed state means the opposite of its label is how a day
                    // gets locked by accident.
                    aria-pressed={isLocked}
                    onClick={() =>
                      onLockedDaysChange(
                        isLocked ? locked.filter((d) => d !== day) : [...locked, day],
                      )
                    }
                    className={[
                      'min-h-11 cursor-pointer px-4 py-2',
                      'text-2xs font-bold uppercase tracking-[0.2em]',
                      'transition-colors duration-150 ease-linear',
                      isLocked
                        ? 'bg-swiss-ink text-swiss-paper'
                        : 'bg-swiss-paper text-swiss-ink hover:bg-swiss-muted',
                    ].join(' ')}
                  >
                    Day {day} {isLocked ? 'closed' : 'open'}
                  </button>
                )
              },
            )}
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
