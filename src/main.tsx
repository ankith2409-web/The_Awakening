import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { AdminProvider } from '@/auth/AdminProvider'
import { AttendeeProvider } from '@/auth/AttendeeProvider'
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
        outside the providers (so a throw in either provider is caught too).

        Without it, a single bad render unmounts everything and the attendee sees a
        blank page. See ErrorBoundary for why that is not a hypothetical.
      */}
      <BoundaryGate>
        {/*
          Two independent providers, not one: attendee and admin are separate
          doors with separate credentials, and neither should ever be able to
          authorise the other.
        */}
        <AttendeeProvider>
          <AdminProvider>
            <App />
          </AdminProvider>
        </AttendeeProvider>
      </BoundaryGate>
    </BrowserRouter>
  </StrictMode>,
)