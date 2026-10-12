import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAdmin, type SessionStatus } from '@/auth/contexts'
import { AdminLoginView } from '@/views/admin/AdminLoginView'
import { AdminPortalView } from '@/views/admin/AdminPortalView'
import { CheckInView } from '@/views/CheckInView'
import { TeamRegistrationView } from '@/views/TeamRegistrationView'
import { TEAM_PORTAL_PATH } from '@/domain/contact'
import { ErrorBoundary } from '@/components/ErrorBoundary'

/**
 * Three public routes and one admin door.
 *
 * The attendee side is two forms with no guard, because there is no session to
 * guard: `/` is the check-in and `/team` is the team registration, both the same
 * for everybody, and neither can be reached without being signed in because there
 * is no such thing.
 *
 * THEY ARE SEPARATE QR CODES ON SEPARATE POSTERS, deliberately. Attendance is per
 * person per day; a team registers once, for the challenge. One code offering both
 * would mean the door's QR also wrote to the teams table, and the door's QR is the
 * one a stranger can type anything into.
 *
 * The landing page, the sign-in form, the registration form, the dashboard and the
 * entry pass were all removed rather than left behind. Each one existed to create
 * or present an account, and a route that renders a page about a feature that no
 * longer exists is a route somebody will find and try to use.
 *
 * `/admin` is unchanged in shape and still a separate door, never linked from the
 * attendee flow.
 */
function Guard({
  status,
  when,
  redirect,
  children,
}: {
  status: SessionStatus
  when: 'active' | 'anonymous'
  redirect: string
  children: ReactNode
}) {
  const location = useLocation()

  // Initialising renders nothing: a half-signed-in frame that flashes the sign-in
  // form and then swaps it is worse than a blank one, because it reads as a real
  // answer for a moment.
  if (status === 'initialising') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <p className="text-2xs font-bold uppercase tracking-[0.25em] text-content-muted">
          Checking session…
        </p>
      </div>
    )
  }

  if (when === 'active' && status !== 'active') {
    return <Navigate to={redirect} replace state={{ from: location.pathname }} />
  }

  if (when === 'anonymous' && status === 'active') {
    return <Navigate to={redirect} replace />
  }

  return <>{children}</>
}

export default function App() {
  const admin = useAdmin()

  return (
    <div className="min-h-dvh bg-swiss-paper text-swiss-ink">
      <ErrorBoundary>
        <Routes>
          {/* The check-in. One page, open to everyone, no account. */}
          <Route path="/" element={<CheckInView />} />

          {/* The team registration. Its own poster, its own QR, same treatment. */}
          <Route path={TEAM_PORTAL_PATH} element={<TeamRegistrationView />} />

          {/* -- admin: a separate door, never linked from the attendee flow -- */}
          <Route
            path="/admin/login"
            element={
              <Guard status={admin.status} when="anonymous" redirect="/admin">
                <AdminLoginView />
              </Guard>
            }
          />
          <Route
            path="/admin"
            element={
              <Guard status={admin.status} when="active" redirect="/admin/login">
                <AdminPortalView />
              </Guard>
            }
          />

          {/*
            Anything else lands on the check-in, not a dead end.

            `/dashboard`, `/login`, `/register` and `/ticket` used to be routes
            here. They are not 404s — they redirect — because a student holding a
            stale link from before the change should end up somewhere that works
            rather than on a page that says no. `/team` is the one path that must
            NOT be swallowed by this, which is why it is declared above rather than
            being left to fall through here.
          */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </div>
  )
}