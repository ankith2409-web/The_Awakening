import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { AdminProvider } from '@/auth/AdminProvider'
import { AttendeeProvider } from '@/auth/AttendeeProvider'
import './styles/index.css'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('Root element #root not found in index.html.')
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
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
    </BrowserRouter>
  </StrictMode>,
)