import { useEffect, useState } from 'react'
import { portalApi } from '@/api'
import { useAttendee } from '@/auth/contexts'
import type { EventInfo } from '@/domain/types'
import { formatEventDateRange } from '@/lib/eventDate'
import { ButtonLink } from '@/components/Button'
import { EventMark } from '@/components/EventMark'
import { SiteFooter } from '@/components/SiteFooter'

/**
 * The public landing page.
 *
 * The first thing an attendee sees when someone sends them the event link, so it
 * answers three questions in one screen: what is this, when and where, and how do
 * I get my pass. Everything below the fold is detail; this is the decision.
 *
 * Event details come from the API rather than being written here, so the dates
 * and venue stay correct when `db/seed.sql` is edited — the same reason the
 * dashboard reads them instead of hardcoding them.
 */
export function LandingView() {
  /*
    Read straight from the context rather than being handed a prop.

    This route now renders for signed-in visitors too, so the hero has to know
    whether there is a session to show the right call to action. `App` still holds
    the page back until `initialising` resolves, so there is no flash of
    "Register" that then swaps to "Your pass".
  */
  const { status, attendee } = useAttendee()
  const signedIn = status === 'active'

  const [event, setEvent] = useState<EventInfo | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    portalApi
      .getEvent()
      .then((value) => {
        if (!cancelled) setEvent(value)
      })
      .catch(() => {
        // The page must still be usable without it: the links are the point, and
        // a failed fetch should not blank the screen.
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#hero-actions"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:border-2 focus:border-swiss-ink focus:bg-swiss-paper focus:px-4 focus:py-3 focus:text-2xs focus:font-bold focus:uppercase focus:tracking-[0.2em]"
      >
        Skip to registration
      </a>

      {/* Masthead — same construction as every other screen. */}
      <header className="flex items-center justify-between gap-4 border-b-2 border-swiss-ink px-6 py-5 sm:px-10 lg:px-14">
        <EventMark />
        <span className="hidden text-2xs font-medium uppercase tracking-[0.2em] text-content-muted sm:block">
          Fetch AI
        </span>
      </header>

      <main className="flex flex-1 flex-col">
        <Hero
          event={event}
          failed={failed}
          signedIn={signedIn}
          attendeeName={attendee?.name ?? null}
        />
      </main>

      <SiteFooter />
    </div>
  )
}

/**
 * The animated composition.
 *
 * Timing is a single deliberate sequence rather than independent effects, so the
 * eye is led top-to-bottom in reading order: rule, then grid, then eyebrow,
 * then headline line by line, then the facts, then the actions.
 *
 * The delays are inline `style` props rather than utility classes because they
 * are per-element data, not a fixed set of variants — Tailwind cannot express
 * arbitrary millisecond delays as static classes.
 */
function Hero({
  event,
  failed,
  signedIn,
  attendeeName,
}: {
  event: EventInfo | null
  failed: boolean
  signedIn: boolean
  attendeeName: string | null
}) {
  const tagline = event?.tagline ?? 'AI agents — built by you'

  /*
    One line per word, driven by the event name rather than hardcoded. The mask
    reveal is per-line, so the split has to come from the data — otherwise
    renaming the event in `db/seed.sql` would leave the headline stale while
    everything below it updated.
  */
  const headline = (event?.name ?? 'THE AWAKENING')
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)

  return (
    <section className="relative overflow-hidden border-b-2 border-swiss-ink">
      {/* Grid, drawn on. Decorative, so hidden from assistive tech. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {[16, 33, 50, 66, 83].map((left, i) => (
          <span
            key={`c${left}`}
            className="hero-anim-column absolute inset-y-0 w-px bg-swiss-ink/10"
            style={{ left: `${left}%`, animationDelay: `${120 + i * 70}ms` }}
          />
        ))}
        {[26, 52, 78].map((top, i) => (
          <span
            key={`r${top}`}
            className="hero-anim-row absolute inset-x-0 h-px bg-swiss-ink/10"
            style={{ top: `${top}%`, animationDelay: `${220 + i * 90}ms` }}
          />
        ))}
      </div>

      {/*
            Vertical rhythm steps down on phones.

            Measured at a 390px viewport, where the facts grid is two rows of
            two (the third item wraps) rather than the single row a tablet gets:

              py-16 / mt-10  ->  buttons at 640-704px, "Log in" 37px below a
                                 667px fold (iPhone SE)
              py-8  / mt-6   ->  buttons at 584-648px, 19px clear

            Desktop is untouched: `sm:` restores the original spacing, and `lg`
            keeps its larger padding.
          */}
      <div className="relative grid gap-12 px-6 py-8 sm:px-10 sm:py-16 lg:grid-cols-12 lg:gap-8 lg:px-14 lg:py-24">
        <div className="lg:col-span-8">
          {/* Opening red rule. */}
          <span
            aria-hidden="true"
            className="hero-anim-rule block h-1 w-24 bg-swiss-accent"
          />

          <div
            className="hero-anim-rise mt-6 flex items-center gap-3"
            style={{ animationDelay: '180ms' }}
          >
            <span className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text">
              01 · Entry
            </span>
          </div>

          {/* Headline: each line rises from behind its own mask. */}
          <h1 className="mt-5 text-[clamp(2.75rem,11vw,7.5rem)] font-black uppercase leading-[0.86] tracking-tighter text-swiss-ink">
            {headline.map((word, i) => (
              <span key={word} className="hero-stage block">
                <span
                  className="hero-anim-line block"
                  style={{ animationDelay: `${260 + i * 110}ms` }}
                >
                  {word}
                </span>
              </span>
            ))}
          </h1>

          <p
            className="hero-anim-rise mt-7 max-w-md text-sm font-medium uppercase leading-relaxed tracking-[0.15em] text-content-muted"
            style={{ animationDelay: '520ms' }}
          >
            {tagline}
          </p>

          <div
            className="hero-anim-wipe mt-8 h-1 w-full max-w-sm bg-swiss-accent"
            style={{ animationDelay: '640ms' }}
            aria-hidden="true"
          />

          {/*
            The facts, in a definition list so they stay associated.

            Labelled Date / Venue / Hosted by rather than When / Where / Host.
            The old labels read like form fields — "When", "Where" — which is
            conversational rather than institutional, and this is an event page
            for a named university. Nouns match how the same three facts are
            labelled on a conference programme.
          */}
          <dl
            className="hero-anim-rise mt-6 grid grid-cols-2 gap-px border-2 border-swiss-ink bg-swiss-ink sm:mt-8 sm:max-w-xl sm:grid-cols-3"
            style={{ animationDelay: '740ms' }}
          >
            {[
              ['Date', event ? formatEventDateRange(event.date, event.endDate) : '—'],
              ['Venue', event ? `${event.venue}, ${event.city}` : '—'],
              ['Hosted by', event?.organiserHost ?? '—'],
            ].map(([term, value]) => (
              <div key={term} className="bg-swiss-paper px-4 py-3">
                <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
                  {term}
                </dt>
                <dd className="mt-1 text-sm font-black tracking-tight text-swiss-ink">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {/*
            Actions. The only thing on the page that is actually interactive.

            Side-by-side from the smallest screen up. They stacked before, which
            put "Log in" 646–710px down the page — entirely below the fold on a
            667px phone, while the red "Register" sat above it. Side-by-side
            both land at 581–645px, so the pair is visible together and a
            returning attendee can see their own path without scrolling.

            Both are `size="lg"` at 64px, so the touch targets are unchanged;
            only the arrangement is. The labels total ~239px at their smallest
            padding, which still fits a 320px viewport.
          */}
          <div
            id="hero-actions"
            className="hero-anim-rise mt-6 flex flex-row gap-2 sm:mt-10 sm:gap-4"
            style={{ animationDelay: '880ms' }}
          >
            {/*
              Two states, one slot.

              Signed in, "Register" and "Log in" are both wrong — and worse than
              wrong, they are misleading: /register and /login are themselves
              guarded, so tapping either would bounce straight back here. Offering
              a signed-in visitor a dead-end pair is the kind of thing that makes
              a page feel broken.

              So a signed-in visitor gets the one thing they came for instead. It
              is still one tap from the shared link, which is what the redirect
              used to provide, and it is honest about what it does.
            */}
            {signedIn ? (
              <ButtonLink to="/dashboard" variant="accent" size="lg">
                Your pass
              </ButtonLink>
            ) : (
              <>
                <ButtonLink to="/register" variant="accent" size="lg">
                  Register
                </ButtonLink>
                <ButtonLink to="/login" variant="secondary" size="lg">
                  Log in
                </ButtonLink>
              </>
            )}
          </div>

          {/*
            Says what Log in is for.

            Two buttons side by side with no distinction invites the wrong one:
            "Register" is the red accent and dominates, so someone who has
            already registered reaches for it again and cannot get back to their
            pass. One line naming the case removes the ambiguity without adding
            a third control.

            Kept to a single line on purpose. At a 390px viewport a two-line
            version ends at 700px — below the fold of a 667px phone — and a note
            that cannot be read is not a note. `sm:` lets it breathe again.

            Placed under the pair rather than beside either button so it reads as
            a note about the row, not a label for the button next to it.

            Replaced when signed in, because "Already registered? Log in here"
            would be nonsense next to a button that is already their pass.
          */}
          <p className="hero-anim-rise mt-3 max-w-md text-2xs font-medium uppercase leading-relaxed tracking-[0.15em] text-content-muted sm:mt-4">
            {signedIn
              ? attendeeName
                ? `Signed in as ${attendeeName}.`
                : 'Signed in.'
              : 'Already registered? Log in here.'}
          </p>

          {failed ? (
            <p
              role="status"
              className="mt-6 max-w-md text-2xs font-medium uppercase tracking-[0.15em] text-content-muted"
            >
              Event details unavailable — registration still works.
            </p>
          ) : null}
        </div>

        {/* Geometric composition, echoing the mark without repeating it. */}
        <div className="hidden lg:col-span-4 lg:flex lg:items-center lg:justify-end">
          <div className="hero-anim-mark w-full max-w-[18rem]" aria-hidden="true">
            <Composition />
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * A circle, a square and the rule between them.
 *
 * Built inline from divs so it can carry the entrance animation and the hero's
 * proportions without inheriting another component's layout.
 */
function Composition() {
  return (
    <div className="relative aspect-4/5 w-full border-2 border-swiss-ink">
      <div className="absolute inset-0 swiss-grid-pattern opacity-60" />
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-swiss-ink/25" />
      <span className="absolute left-0 right-0 top-[58%] h-px bg-swiss-ink/25" />
      <span className="absolute left-[14%] top-[18%] size-[34%] rounded-full border-2 border-swiss-ink bg-swiss-accent" />
      <span className="absolute bottom-[16%] right-[12%] h-[26%] w-[30%] border-2 border-swiss-ink swiss-dots" />
      <span className="absolute bottom-0 left-0 h-2 w-[38%] bg-swiss-accent" />
    </div>
  )
}
