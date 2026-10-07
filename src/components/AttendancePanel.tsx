import type { CheckIn, MyAttendance } from '@/domain/types'
import { Skeleton } from './Skeleton'

/**
 * Attendance status, one row per day.
 *
 * Read-only by design: an attendee cannot mark themselves present, and there is
 * no control here to do so. A record exists only because staff scanned their code
 * at the gate.
 *
 * Why a row per day rather than one "Attendance Marked":
 *
 * Not everyone comes on both days, and a single flag cannot say which. The old
 * version told somebody who came on day two that they had been marked — full stop
 * — and somebody who came on day one only that they were marked for an event with
 * a second day still to come. Both readings are wrong, and the second one is
 * wrong in the direction that matters: they turn up on day two expecting nothing
 * to be needed.
 *
 * Days with no record render as "not yet" rather than being hidden. An absence the
 * attendee can see is information; an absence that is not visible is not.
 */
export function AttendancePanel({
  attendance,
  loading,
}: {
  attendance: MyAttendance | null
  loading: boolean
}) {
  if (loading) {
    return (
      <Frame>
        <Skeleton className="h-32 w-full border-0" />
      </Frame>
    )
  }

  const totalDays = attendance?.totalDays ?? 1
  const activeDay = attendance?.activeDay ?? 1
  const records = attendance?.records ?? []

  /*
    Map day number to record, and fill the gaps. An attendee who came on day one
    only gets a row saying so for day two, which is the whole point.
  */
  const byDay = new Map<number, CheckIn>()
  for (const record of records) byDay.set(record.day, record)

  const days = Array.from({ length: totalDays }, (_, index) => index + 1)
  const lockedDays = attendance?.lockedDays ?? []

  return (
    <Frame>
      <ul className="flex flex-col">
        {days.map((day) => {
          const record = byDay.get(day)
          return (
            <DayRow
              key={day}
              day={day}
              record={record ?? null}
              isToday={day === activeDay}
              isLocked={lockedDays.includes(day)}
            />
          )
        })}
      </ul>

      <p className="border-t-2 border-swiss-ink px-6 py-4 text-2xs font-medium leading-relaxed text-content-muted">
        Marked at the gate, once a day. A record is final and cannot be changed.
      </p>
    </Frame>
  )
}

/**
 * One day.
 *
 * The square is filled when marked and hollow when not, so the difference is a
 * shape rather than a colour — which is also what makes it legible on the cheap
 * phone somebody is holding at chest height while walking through a door.
 */
function DayRow({
  day,
  record,
  isToday,
  isLocked,
}: {
  readonly day: number
  readonly record: CheckIn | null
  readonly isToday: boolean
  readonly isLocked: boolean
}) {
  const marked = record !== null
  /*
    Only meaningful when there is no record.

    A locked day somebody WAS marked on is history and reads exactly as it should —
    "marked", with a time. Locking stops new marks; it does not undo or diminish
    the old ones.
  */
  const missedAndClosed = !marked && isLocked

  return (
    <li
      className={[
        'border-b border-swiss-ink/15 p-6 last:border-b-0',
        // The row that matters most is the one being scanned into right now.
        isToday ? 'bg-swiss-muted' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-5">
        <span
          aria-hidden="true"
          className={[
            'mt-1 size-6 shrink-0',
            marked ? 'bg-swiss-accent-text' : 'border-2 border-swiss-ink',
          ].join(' ')}
        />

        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xl font-black uppercase leading-tight tracking-tight text-swiss-ink">
              Day {day}
            </span>
            {isToday ? (
              <span className="border border-swiss-ink px-2 py-0.5 text-2xs font-bold uppercase tracking-[0.15em] text-swiss-ink">
                Today
              </span>
            ) : null}
          </p>

          <p
            className={[
              'mt-1 text-2xs font-bold uppercase tracking-[0.2em]',
              marked ? 'text-swiss-accent-text' : 'text-content-muted',
            ].join(' ')}
          >
            {marked ? 'Marked' : missedAndClosed ? 'Closed' : 'Not marked yet'}
          </p>

          {record === null ? (
            /*
              Two different situations that used to share one sentence.

              "Not marked yet" plus "show your pass at the gate, this updates on its
              own" is right for a day still to come and wrong for a day an organiser
              has closed. On a closed day that instruction can never succeed, so
              somebody who missed it would sit watching a status that will never
              change, having been told it updates by itself. The fix is not to make
              the panel lie less — it is to stop telling them to do something that
              will not work, and to say who can still act.
            */
            <p className="mt-2 text-2xs font-medium leading-relaxed text-content-muted">
              {missedAndClosed
                ? `Attendance for day ${day} is closed, so it can no longer be marked. Email ankith2409@gmail.com if you think this is a mistake.`
                : `Show your pass at the gate on day ${day}. This updates on its own.`}
            </p>
          ) : (
            /*
              `motion-scale-in` because this is the panel an attendee watches. It
              flips from "not yet" to "marked" by itself, with no reload and
              without them touching anything — the poll catches the scan. Without
              a transition the text simply changes, which is very easy to miss; the
              motion is what makes a background state change legible.
            */
            <div role="status" className="motion-scale-in">
              <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
                <div>
                  <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
                    Time
                  </dt>
                  <dd className="font-mono text-sm font-bold text-swiss-ink">
                    {formatTime(record.at)}
                  </dd>
                </div>
                <div>
                  <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
                    Via
                  </dt>
                  <dd className="text-2xs font-bold uppercase tracking-[0.15em] text-swiss-ink">
                    {record.method === 'qr' ? 'Pass verified' : 'Typed SEN'}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="attendance-heading"
      className="flex flex-col border-2 border-swiss-ink bg-swiss-paper"
    >
      <header className="flex items-baseline justify-between gap-3 border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3">
        <h2
          id="attendance-heading"
          className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper"
        >
          Attendance
        </h2>
        <span className="font-mono text-2xs font-bold text-swiss-accent-on-dark">05.</span>
      </header>
      {children}
    </section>
  )
}

function formatTime(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed)
}