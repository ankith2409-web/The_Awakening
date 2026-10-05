import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'

/**
 * Catches a render-time crash and shows a recovery panel instead of a white page.
 *
 * WHY THIS EXISTS
 *
 * React unmounts the entire tree when a component throws while rendering. Without a
 * boundary that is a white screen with no explanation, no way back, and nothing in
 * the console unless you happen to have DevTools open. On a phone at a registration
 * desk that reads as "the website is down", and the person whose job it is to fix it
 * has no way to tell that it was one bad render rather than the whole site.
 *
 * The realistic triggers are all data-shaped, which is why they survive testing:
 * an unexpected `null` in a response, a renamed column, a browser quirk in the
 * camera API. None of them is a broken build, and all of them blank the page.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not retry automatically. A render that threw once from bad data will throw
 * again on the same data, and a reload loop at the gate looks exactly like the
 * outage it replaced. It offers a deliberate retry instead, and recovery on
 * navigation — because a boundary that stays broken after the URL changes is not a
 * recovery panel, it is a tombstone.
 *
 * A class component is not a stylistic choice: React only supports error boundaries
 * on class components. There is no hook equivalent.
 */

interface Props {
  children: ReactNode
  /**
   * Changes whenever the route changes, which clears a captured error.
   *
   * A stuck boundary would trap somebody on a broken page even though the rest of
   * the app works. Keying recovery to the URL means navigating away always gets
   * you somewhere, which is the only escape that does not depend on the thing that
   * just having broken.
   */
  resetKey?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console, with the component stack. It is the only place the
    // detail survives, and the panel deliberately does not show internals.
    console.error('[ui] render failed', error, info.componentStack)
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (error === null) return this.props.children

    return (
      <main className="min-h-dvh bg-swiss-paper px-6 py-16 sm:px-10 lg:px-14">
        <div className="mx-auto max-w-2xl border-t-4 border-swiss-ink pt-8">
          <p className="text-2xs font-bold uppercase tracking-[0.25em] text-content-muted">
            Something went wrong
          </p>

          <h1 className="mt-4 text-3xl font-black tracking-tight text-swiss-ink sm:text-5xl">
            This page could not load
          </h1>

          {/*
            No stack trace, no error message. Whatever went wrong is more likely to
            be alarming than useful to somebody holding a phone, and the detail is
            already in the console for whoever is actually debugging.
          */}
          <p className="mt-4 max-w-prose text-base font-medium leading-relaxed text-content-muted">
            Nothing you have entered has been lost, and nothing was sent anywhere.
            Reloading usually fixes it. If it keeps happening, the details are in the
            browser console.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="h-14 cursor-pointer border-2 border-swiss-ink bg-swiss-ink px-6 text-xs font-bold uppercase tracking-[0.2em] text-swiss-paper transition-colors duration-150 ease-linear hover:border-swiss-accent-text hover:bg-swiss-accent-text focus:outline-2 focus:outline-offset-2 focus:outline-swiss-accent-text"
            >
              Try again
            </button>

            {/*
              Two exits, because there are two separate doors in this app and a
              failure in one must not lock somebody out of the other. Someone whose
              attendee pass failed to render still has to be able to reach the
              registration desk.
            */}
            <Link
              to="/"
              className="inline-flex h-14 items-center border-2 border-swiss-ink bg-swiss-paper px-6 text-xs font-bold uppercase tracking-[0.2em] text-swiss-ink transition-colors duration-150 ease-linear hover:bg-swiss-ink hover:text-swiss-paper focus:outline-2 focus:outline-offset-2 focus:outline-swiss-accent-text"
            >
              Home
            </Link>
            <Link
              to="/login"
              className="inline-flex h-14 items-center border-2 border-swiss-ink bg-swiss-paper px-6 text-xs font-bold uppercase tracking-[0.2em] text-swiss-ink transition-colors duration-150 ease-linear hover:bg-swiss-ink hover:text-swiss-paper focus:outline-2 focus:outline-offset-2 focus:outline-swiss-accent-text"
            >
              Attendee log in
            </Link>
            <Link
              to="/admin"
              className="inline-flex h-14 items-center border-2 border-swiss-ink bg-swiss-paper px-6 text-xs font-bold uppercase tracking-[0.2em] text-swiss-ink transition-colors duration-150 ease-linear hover:bg-swiss-ink hover:text-swiss-paper focus:outline-2 focus:outline-offset-2 focus:outline-swiss-accent-text"
            >
              Admin
            </Link>
          </div>
        </div>
      </main>
    )
  }
}

/**
 * Supplies the current path as `resetKey`.
 *
 * A separate component because `useLocation` needs a Router above it, and the
 * boundary must sit inside the Router to read the route while still sitting above
 * the providers and pages it protects.
 */
export function BoundaryGate({ children }: { children: ReactNode }) {
  return <ErrorBoundary resetKey={useLocation().pathname}>{children}</ErrorBoundary>
}