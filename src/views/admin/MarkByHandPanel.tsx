import { useCallback, useState } from 'react'
import { portalApi } from '@/api'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { useAdmin } from '@/auth/contexts'

/**
 * Mark somebody in by hand.
 *
 * The one case self-service cannot cover.
 *
 * A student whose phone has no battery, whose name they cannot type in the time
 * they have, or who is standing in front of an organiser with the door open and a
 * queue behind them. They say their name and their SEN; the organiser types it and
 * the mark lands exactly as a check-in would have.
 *
 * WHY IT IS HERE AND NOT ON THE SCREEN TAB
 *
 * The screen tab is the door, and the door is a queue. This is the exception, so
 * it lives with the register it appends to, where somebody goes when they are
 * looking for a person rather than processing a line.
 *
 * IT CAN ONLY MARK, NOT CREATE
 *
 * `POST /admin/attendance` needs a SEN that is already in the register, and that
 * is deliberate even though it is inconvenient here. The old add-by-hand panel
 * made an account from a form; this marks an attendance row, and if the student
 * is genuinely new the correct move is for the organiser to have them use the wall
 * QR like everybody else — which takes four seconds and produces the same record.
 * A panel that can invent a person is a panel that can invent somebody's name.
 */
export function MarkByHandPanel({ onMarked }: { onMarked: () => void }) {
  const { event, refresh } = useAdmin()
  const [sen, setSen] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const activeDay = event?.activeDay ?? 1
  const dayLocked = (event?.lockedDays ?? []).includes(activeDay)

  const submit = useCallback(
    async (event_: React.FormEvent) => {
      event_.preventDefault()
      if (busy) return

      setBusy(true)
      setProblem(null)
      setDone(null)
      try {
        const result = await portalApi.recordAttendanceBySen(sen)
        setDone(`${result.attendee.name} — ${result.attendee.sen}, day ${result.day}`)
        setSen('')
        refresh()
        onMarked()
      } catch (cause) {
        setProblem(cause instanceof Error ? cause.message : 'Could not record that.')
      } finally {
        setBusy(false)
      }
    },
    [busy, onMarked, refresh, sen],
  )

  return (
    <section className="border-2 border-swiss-ink">
      <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
        Mark somebody in
      </h2>

      <div className="flex flex-col gap-4 p-6">
        <p className="text-2xs font-medium leading-relaxed text-content-muted">
          For a student who cannot use the QR themselves — no phone, no signal, or
          no time. Type their SEN and the mark is recorded for day {activeDay}, the
          same as a check-in.
        </p>

        {dayLocked ? (
          <p className="border-l-4 border-swiss-ink bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
            Attendance for day {activeDay} is closed. Reopen it on the Event tab.
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field
              label="SEN"
              value={sen}
              onChange={(e) => setSen(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="A866175000012"
              required
              maxLength={16}
            />

            {problem !== null ? (
              <p
                role="alert"
                className="border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
              >
                {problem}
              </p>
            ) : null}

            {done !== null ? (
              <p
                role="status"
                className="border-l-4 border-swiss-ink bg-swiss-muted p-4 text-2xs font-bold leading-relaxed tracking-[0.15em] text-swiss-ink"
              >
                Marked: {done}
              </p>
            ) : null}

            <Button type="submit" variant="accent" size="lg" loading={busy}>
              {busy ? 'Recording' : 'Mark in'}
            </Button>
          </form>
        )}
      </div>
    </section>
  )
}