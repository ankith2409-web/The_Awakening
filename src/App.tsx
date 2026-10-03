import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAdmin, useAttendee, type SessionStatus } from '@/auth/contexts'
import { AdminLoginView } from '@/views/admin/AdminLoginView'
import { AdminPortalView } from '@/views/admin/AdminPortalView'
import { LoginView, RegisterView } from '@/views/AuthViews'
import { ForgotPasswordView } from '@/views/ForgotPasswordView'
import { LandingView } from '@/views/LandingView'
import { DashboardView } from '@/views/DashboardView'

/**
 * A stable placeholder for the session probe.
 *
 * Deliberately not a spinner: it holds the page's geometry so nothing jumps
 * when the session resolves.
 */
function BootScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center swiss-grid-pattern">
      <output className="text-2xs font-bold uppercase tracking-[0.3em] text-swiss-ink">
        Verifying session…
      </output>
    </div>
  )
}

/**
 * Route guard.
 *
 * While the probe is in flight it renders the placeholder rather than
 * redirecting — bouncing a signed-in user to /login and back would be both
 * confusing and wrong.
 */
function Guard({
  status,
  when,
  redirect,
  children,
}: {
  status: SessionStatus
  /**
   * The state that is allowed through, or `'any'`.
   *
   * `'any'` renders the route for a signed-in visitor as well as an anonymous
   * one — used by the landing page, which has to honour the promise the shared
   * link makes. It still waits out `initialising`, so the page never flashes one
   * version and then swaps.
   */
  when: SessionStatus | 'any'
  redirect: string
  children: ReactNode
}) {
  const location = useLocation()

  if (status === 'initialising') return <BootScreen />
  if (when !== 'any' && status !== when) {
    // `state.from` lets the destination send the user back after signing in.
    return <Navigate to={redirect} replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}

export function App() {
  const attendee = useAttendee()
  const admin = useAdmin()
  const location = useLocation()

  return (
    /*
      One short cross-fade per navigation.

      Keyed on the pathname so the animation replays on every route change. The
      effect is orientation: a page that arrives with nothing happening reads as
      a page swap, and the eye loses its place. 260ms is short enough to feel
      like the same surface changing rather than a transition being performed.

      Not applied to the boot screen — that is a wait, and a fade on a wait just
      makes the wait look longer.
    */
    <div key={location.pathname} className="motion-fade contents">
      <Routes>
      {/* -- landing ------------------------------------------------------ */}
      {/*
        The public landing page, for signed-in visitors too.

        This used to be `when="anonymous" redirect="/dashboard"`, so anyone
        holding a session cookie was bounced to their pass and the hero never
        rendered. That is defensible in isolation — a registered attendee tapping
        the link wants their QR — but it made the link lie: the page it pointed at
        was not the page you got, and an organiser checking the public page had no
        way to see it at all without signing out.

        The link is the thing being shared in a group chat, so it should show what
        it promises. The attendee's shortcut is not lost — `LandingView` swaps its
        actions for a direct "Your pass" link once it knows there is a session, so
        reaching the QR is still one tap.

        Still waits out `initialising`, so this does not flash Register and then
        swap to Your pass.
      */}
      <Route
        path="/"
        element={
          <Guard status={attendee.status} when="any" redirect="/dashboard">
            <LandingView />
          </Guard>
        }
      />

      {/* -- attendee ---------------------------------------------------- */}
      <Route
        path="/login"
        element={
          <Guard
            status={attendee.status}
            when="anonymous"
            redirect="/dashboard"
          >
            <LoginView />
          </Guard>
        }
      />
      <Route
        path="/register"
        element={
          <Guard
            status={attendee.status}
            when="anonymous"
            redirect="/dashboard"
          >
            <RegisterView />
          </Guard>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <Guard
            status={attendee.status}
            when="anonymous"
            redirect="/dashboard"
          >
            <ForgotPasswordView />
          </Guard>
        }
      />
      <Route
        path="/dashboard"
        element={
          <Guard
            status={attendee.status}
            when="active"
            redirect="/login"
          >
            <DashboardView />
          </Guard>
        }
      />

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

      {/* Unknown paths land on sign-in, not a dead end. */}
      <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </div>
  )
}
