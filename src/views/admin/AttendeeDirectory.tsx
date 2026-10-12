import { useMemo, useState } from 'react'
import { useAdmin } from '@/auth/contexts'
import { normaliseSen } from '@/domain/phone'
import { Field } from '@/components/Field'
import { SectionLabel } from '@/components/Typography'
import { Skeleton } from '@/components/Skeleton'

/**
 * Who is in the room.
 *
 * WAS the registration desk: find an attendee, set their password, recover a
 * locked-out account. All of that went with the accounts. What is left is the one
 * thing the panel was always being used for as well — checking whether somebody
 * is on the list — and it does that without a form in the way.
 *
 * EMPTY FOR A `gate` ACCOUNT, AND NOT BY OMISSION.
 *
 * `GET /admin/attendees` returns every name, phone and SEN, so the provider does
 * not call it for a `gate` session and the server refuses it independently. This
 * panel says so rather than rendering an empty list that reads like "nobody has
 * checked in yet", which would be a lie told to the one person most likely to
 * need the information.
 *
 * SEARCHED ON ALL THREE FIELDS.
 *
 * A volunteer at a door has a name, a SEN or a phone number and does not know
 * which they have. Matching on one field means the other two are a guess, and a
 * guess at 8am is a person who is not in the room.
 */
export function AttendeeDirectory() {
  const { attendees, admin, loadingData } = useAdmin()
  const [filter, setFilter] = useState('')

  const isOwner = admin?.role === 'owner'

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle === '') return attendees
    return attendees.filter((person) =>
      [person.name, person.sen, person.phone].some((field) =>
        String(field ?? '').toLowerCase().includes(needle),
      ),
    )
  }, [attendees, filter])

  if (!isOwner) {
    return (
      <section className="border-2 border-swiss-ink">
        <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
          Who is in the room
        </h2>
        <p className="p-6 text-2xs font-medium leading-relaxed text-content-muted">
          The full list of names, phone numbers and SENs is only available to an
          owner. Mark attendance from the Attendance tab — it works on any account.
        </p>
      </section>
    )
  }

  return (
    <section className="border-2 border-swiss-ink">
      <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
        Who is in the room
      </h2>

      <div className="flex flex-col gap-4 p-6">
        {loadingData && attendees.length === 0 ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <SectionLabel index="01">Registered so far</SectionLabel>

            <p className="text-sm font-black tracking-tight text-swiss-ink">
              {attendees.length} {attendees.length === 1 ? 'person' : 'people'}
            </p>

            <Field
              label="Filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Name, SEN or phone"
              autoComplete="off"
              spellCheck={false}
            />

            {/*
              Bounded with its own scrollbar rather than growing the page. The
              People tab is one of several stacked sections, and a list that made
              the tab ten thousand pixels tall would push everything below it off a
              phone screen.
            */}
            <ul className="max-h-96 overflow-y-auto border-2 border-swiss-ink">
              {filtered.map((person) => (
                <li
                  key={person.id}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-swiss-ink/15 px-4 py-3 last:border-b-0"
                >
                  <span className="text-sm font-bold text-swiss-ink">{person.name}</span>
                  <span className="font-mono text-2xs text-content-muted">
                    {normaliseSen(person.sen)}
                  </span>
                  <span className="font-mono text-2xs text-content-muted">
                    {person.phone}
                  </span>
                </li>
              ))}

              {filtered.length === 0 ? (
                <li className="px-4 py-4 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                  {attendees.length === 0 ? 'Nobody has checked in yet' : 'Nobody matches that'}
                </li>
              ) : null}
            </ul>

            {filtered.length !== attendees.length ? (
              <p className="text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                Showing {filtered.length} of {attendees.length}
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}