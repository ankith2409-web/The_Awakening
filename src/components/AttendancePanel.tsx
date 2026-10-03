import type { CheckIn } from '@/domain/types'
import { Skeleton } from './Skeleton'

/**
 * Attendance status.
 *
 * Read-only by design: an attendee cannot mark themselves present, and there
 * is no control here to do so. The record exists only because staff scanned
 * their code at the gate.
 */
export function AttendancePanel({
  attendance,
  loading,
}: {
  attendance: CheckIn | null
  loading: boolean
}) {
  const marked = attendance !== null

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

      {loading ? (
        <Skeleton className="h-32 w-full border-0" />
      ) : marked ? (
        /*
          `motion-scale-in` because this panel is the one an attendee watches.
          It flips from "not yet" to "marked" by itself, with no reload and
          without them touching anything — the live poll catches the scan. Without
          a transition the text simply changes, which on a phone held at chest
          height while walking through a door is very easy to miss; the motion is
          what makes a background state change legible.
        */
        <div
          role="status"
          className="motion-scale-in flex items-start gap-5 p-6"
        >
          {/* Solid square, not a tick: the system prefers geometry to icons. */}
          <span
            aria-hidden="true"
            className="mt-1 size-6 shrink-0 bg-swiss-accent-text"
          />
          <div className="min-w-0">
            <p className="text-xl font-black uppercase leading-tight tracking-tight text-swiss-ink">
              Attendance Marked
            </p>
            <p className="mt-2 text-2xs font-medium leading-relaxed text-content-muted">
              Recorded at the gate. This record is final and cannot be changed.
            </p>
            <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2">
              <div>
                <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
                  Time
                </dt>
                <dd className="font-mono text-sm font-bold text-swiss-ink">
                  {formatTime(attendance.at)}
                </dd>
              </div>
              <div>
                <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
                  Gate
                </dt>
                <dd className="text-sm font-bold tracking-tight text-swiss-ink">
                  {attendance.gate}
                </dd>
              </div>
              <div>
                <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
                  SEN
                </dt>
                <dd className="font-mono text-sm font-bold text-swiss-ink">
                  {attendance.sen}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      ) : (
        <div className="p-6">
          <p className="text-xl font-black uppercase leading-tight tracking-tight text-content-muted">
            Not Marked Yet
          </p>
          <p className="mt-2 text-2xs font-medium leading-relaxed text-content-muted">
            Show your pass at the gate. Staff scan it and this updates
            automatically — there is nothing for you to do.
          </p>
        </div>
      )}
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
