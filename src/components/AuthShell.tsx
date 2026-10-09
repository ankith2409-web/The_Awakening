import type { ReactNode } from 'react'
import { SiteFooter } from './SiteFooter'

/**
 * The auth layout.
 *
 * Single full-width column. The form is the only thing on the page, so the
 * layout gets out of its way: masthead, then the form, centred in the viewport
 * with the 24px grid doing the work through spacing and rules alone.
 *
 * Previously an 8:4 split carried a design-manifesto panel — "The Grid Is Law",
 * a geometric composition, texture swatches and a token spec table. It appeared
 * on the attendee sign-in, attendee register and admin sign-in screens alike,
 * because all three share this shell. It documented the design system rather
 * than serving the person signing in, so it has been removed. The geometric
 * identity still lives in the masthead mark and the texture utilities.
 *
 * It also carries the site footer, because a footer belongs to the page rather
 * than to whatever is in the middle of it, and the shell already owns the flex
 * column (`main` is `flex-1`, the footer is `mt-auto`) that pushes one to the
 * bottom. Adding it here rather than to each view keeps it off the radar of the
 * next auth page somebody writes.
 *
 * It is OPT-IN and defaults to off, so the shared admin sign-in is unaffected.
 * A default that added a public "Hosted by" block to the staff door would be the
 * wrong way round: the safe state is no change, and every attendee page says yes
 * on purpose.
 */
export function AuthShell({
  logo,
  eyebrow,
  title,
  description,
  children,
  footer,
  showSiteFooter = false,
}: {
  /** Masthead mark. Passed in so callers own the identity, not the shell. */
  logo: ReactNode
  eyebrow: string
  title: string
  description: string
  children: ReactNode
  footer?: ReactNode
  /** Attendee pages pass true. The admin sign-in deliberately does not. */
  showSiteFooter?: boolean
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#auth-form"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:border-2 focus:border-swiss-ink focus:bg-swiss-paper focus:px-4 focus:py-3 focus:text-2xs focus:font-bold focus:uppercase focus:tracking-[0.2em]"
      >
        Skip to form
      </a>

      {/* Masthead: wordmark and status, separated by a visible rule. */}
      <header className="flex items-center justify-between gap-4 border-b-2 border-swiss-ink px-6 py-5 sm:px-10 lg:px-14">
        {logo}
        <span className="hidden text-2xs font-medium uppercase tracking-[0.2em] text-content-muted sm:block">
          Fetch AI
        </span>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-12 sm:px-10 lg:px-14 lg:py-16">
        <div className="w-full max-w-xl">
          <div className="flex items-center gap-3">
            <span className="h-[3px] w-12 bg-swiss-accent" />
            <span className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text">
              {eyebrow}
            </span>
          </div>

          {/* Let the words be the image. tracking-tighter is the system default. */}
          <h1 className="mt-6 text-6xl font-black uppercase leading-[0.88] tracking-tighter text-swiss-ink">
            {title}
          </h1>

          <p className="mt-6 max-w-md text-sm font-medium leading-relaxed text-content-muted">
            {description}
          </p>

          <div className="mt-10">{children}</div>

          {footer ? (
            <div className="mt-10 border-t-2 border-swiss-ink pt-6">{footer}</div>
          ) : null}
        </div>
      </main>

      {showSiteFooter ? <SiteFooter /> : null}
    </div>
  )
}
