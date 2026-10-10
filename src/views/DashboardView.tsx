import { useAttendee } from '@/auth/contexts'
import { Button } from '@/components/Button'
import { Alert } from '@/components/Typography'
import { AttendancePanel } from '@/components/AttendancePanel'
import { EventMark } from '@/components/EventMark'
import { EventStatusPanel } from '@/components/EventStatusPanel'
import { QrTicket } from '@/components/QrTicket'
import { SiteFooter } from '@/components/SiteFooter'
import { formatPhone } from '@/domain/phone'
import { formatEventDateRange } from '@/lib/eventDate'

/**
 * The attendee dashboard.
 *
 * Two columns with unequal mass — 5 for the pass, 7 for everything else. The
 * pass is the reason the user opened the app, so it carries the most weight
 * and comes first in DOM order for screen readers.
 *
 * Teams are deliberately absent: they are an organiser concern and live only
 * in the admin portal.
 *
 * The root is a flex column with `main` as `flex-1`, which is what lets the site
 * footer sit at the bottom of the viewport on a short page instead of floating
 * halfway up under the pass. `SiteFooter` is `mt-auto`, so it only claims the
 * slack.
 */
export function DashboardView() {
  const { attendee, event, attendance, ticket, loadingData, error, logout } =
    useAttendee()

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b-4 border-swiss-ink bg-swiss-paper px-4 py-4 sm:gap-4 sm:px-10 lg:px-14">
        <EventMark />

        <div className="flex items-center gap-3 sm:gap-4">
          {attendee ? (
            <div className="hidden text-right sm:block">
              {/* "Signed in" broke the house rule that the verb is "log", not "sign". */}
              <p className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
                Registered as
              </p>
              <p className="text-sm font-black tracking-tight text-swiss-ink">
                {attendee.name}
              </p>
            </div>
          ) : null}
          <Button variant="secondary" size="md" onClick={() => void logout()}>
            Log out
          </Button>
        </div>
      </header>

      <main className="flex-1 px-6 py-10 sm:px-10 lg:px-14 lg:py-14">
        <div className="mx-auto max-w-[92rem]">
          <div className="flex flex-col gap-6 border-b-2 border-swiss-ink pb-8 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="flex items-center gap-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text">
                <span className="h-[3px] w-12 bg-swiss-accent-text" />
                01. Attendee Pass
              </p>
              <h1 className="mt-4 text-[clamp(1.75rem,9vw,3.75rem)] font-black uppercase leading-[0.88] tracking-tighter text-swiss-ink">
                Welcome
              </h1>
            </div>

            <dl className="grid grid-cols-2 gap-px border-2 border-swiss-ink bg-swiss-ink sm:grid-cols-3">
              {[
                ['Name', attendee?.name ?? '—'],
                ['Phone', attendee ? formatPhone(attendee.phone) : '—'],
                ['SEN', attendee?.sen ?? '—'],
                ['Event', event?.name ?? '—'],
                ['Tagline', event?.tagline ?? '—'],
                ['Organiser', event?.organiser ?? '—'],
                // Only when it differs from the organiser: this event is run by
                // GDG and hosted at Amity University Bengaluru, and a row with
                // an empty value would be worse than no row.
                ...(event?.organiserHost
                  ? ([['Hosted by', event.organiserHost]] as [string, string][])
                  : []),
                ['Venue', event ? `${event.venue}, ${event.city}` : '—'],
                ['Date', event ? formatEventDateRange(event.date, event.endDate) : '—'],
              ].map(([term, value]) => (
                <div key={term} className="bg-swiss-muted px-4 py-3">
                  <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
                    {term}
                  </dt>
                  <dd className="mt-1 max-w-[14rem] break-words text-sm font-black tracking-tight text-swiss-ink">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {error ? (
            <div className="mt-8 max-w-md">
              <Alert>{error.message}</Alert>
            </div>
          ) : null}

          <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <QrTicket
                ticket={ticket}
                attendee={attendee}
                loading={loadingData}
              />
            </div>

            <div className="flex flex-col gap-8 lg:col-span-7">
              <AttendancePanel
                attendance={attendance}
                event={event}
                loading={loadingData}
              />
              <EventStatusPanel event={event} loading={loadingData} />
            </div>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
