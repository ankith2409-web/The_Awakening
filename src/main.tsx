import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AdminProvider } from '@/auth/AdminProvider'
import { BoundaryGate } from './components/ErrorBoundary'
import './styles/index.css'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('Root element #root not found in index.html.')
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      {/*
        The boundary sits inside the Router (so it can recover on navigation) and
        outside the providers (so a throw in the provider is caught too).

        Without it, a single bad render unmounts everything and the attendee sees
        a blank page — which on the morning of an event is the one failure that
        cannot be diagnosed from where you are standing. See ErrorBoundary for why
        that is not a hypothetical.
      */}
      <BoundaryGate>
        {/*
          ONE provider, not two.

          There were two because attendee and admin are separate doors with
          separate credentials, and neither should ever be able to authorise the
          other. The attendee half went with the accounts: with no session there is
          nothing for an attendee provider to hold, and a provider whose values are
          always null is a thing to read past rather than a thing that tells you
          the feature is gone.

          The admin half is unchanged, and still cannot see an attendee's
          identity — nobody can, because there isn't one.
        */}
        <AdminProvider>
          <App />
        </AdminProvider>
      </BoundaryGate>
    </BrowserRouter>
  </StrictMode>,
)