import type { EventInfo } from './types'

/**
 * Seed programme data.
 *
 * THIS IS THE SWAP POINT for the real dataset you are supplying later.
 * Replace the contents of these exports (or move them to JSON and fetch them)
 * — nothing else in the app needs to change, because every consumer only ever
 * sees the typed shapes in `src/domain/types.ts`.
 */

export const SEED_EVENT: EventInfo = {
  id: 'evt_awakening_2026',
  name: 'THE AWAKENING',
  tagline: 'AI agents — built by you',
  organiser: 'Google Developer Groups',
  organiserHost: 'Amity University Bengaluru',
  date: '2026-10-13',
  endDate: '2026-10-14',
  venue: 'Auditorium',
  city: 'Bengaluru',
  phase: 'registration',
  capacity: 480,
  /*
    Which day attendance is recorded against. Both are resolved from these dates
    by the server, never by the client: there is nothing at the door to leave on
    the wrong setting.
  */
  activeDay: 1,
  calendarDay: 1,
  totalDays: 2,
  dayOverridden: false,
  registrationMode: 'open',
  rosterCount: 0,
  // The mock has no push service, so it never has an announcement to carry either.
  // Null takes exactly the same code path as a deployment that has sent nothing yet,
  // which means the banner's empty state is exercised without a second branch.
  announcement: null,
  dayOverride: null,
  lockedDays: [],
  agenda: [
    { id: 'ag_01', day: 1, startsAt: null, title: 'Technical sessions', speaker: 'Aryan Gandhi & Tanisha Sharma', room: null },
    { id: 'ag_02', day: 1, startsAt: null, title: 'Ecosystem exploration', speaker: 'Aryan Gandhi & Tanisha Sharma', room: null },
    { id: 'ag_03', day: 1, startsAt: null, title: 'Challenge Brief & Rules', speaker: 'Aryan Gandhi & Tanisha Sharma', room: null },
    { id: 'ag_04', day: 2, startsAt: null, title: 'Challenge kick-off', speaker: 'Aryan Gandhi & Tanisha Sharma', room: null },
    { id: 'ag_05', day: 2, startsAt: null, title: 'Idea formation', speaker: 'Aryan Gandhi & Tanisha Sharma', room: null },
    { id: 'ag_06', day: 2, startsAt: null, title: 'Team setup', speaker: 'Aryan Gandhi & Tanisha Sharma', room: null },
    { id: 'ag_07', day: 2, startsAt: null, title: 'Project development', speaker: 'Aryan Gandhi & Tanisha Sharma', room: null },
    { id: 'ag_08', day: 2, startsAt: null, title: 'Demonstrations', speaker: 'Aryan Gandhi & Tanisha Sharma', room: null },
    { id: 'ag_09', day: 2, startsAt: null, title: 'Evaluation', speaker: 'Aryan Gandhi & Tanisha Sharma', room: null },
    { id: 'ag_10', day: 2, startsAt: null, title: 'Closing', speaker: 'Aryan Gandhi & Tanisha Sharma', room: null },
  ],
}

export const SEED_ADMINS = [
  { id: 'adm_01', username: 'admin', displayName: 'Event Operations' },
] as const

/**
 * Demo attendee. Password `grid2026`. Present only in the mock backend.
 *
 * `sen` is the value their barcode carries. Amity University SENs are a single
 * letter followed by twelve digits, so the demo barcode follows that shape —
 * `A866175000012` is an invented example, not anyone's real number.
 */
export const SEED_ATTENDEE = {
  id: 'att_demo_01',
  name: 'Demo Attendee',
  phone: '9876543210',
  sen: 'A866175000012',
  password: 'grid2026',
} as const
