import type { EventInfo, Team } from './types'

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
  date: '2026-10-14',
  endDate: '2026-10-15',
  venue: 'Seminar Hall',
  city: 'Bengaluru',
  phase: 'registration',
  capacity: 480,
  agenda: [
    { id: 'ag_01', day: 1, startsAt: '09:30', title: 'Registration & Badges', speaker: 'GDG Bengaluru', room: 'Seminar Hall', status: 'done' },
    { id: 'ag_02', day: 1, startsAt: '10:00', title: 'Opening: What Awakens', speaker: 'Dr. Anjali Rao', room: 'Seminar Hall', status: 'done' },
    { id: 'ag_03', day: 1, startsAt: '11:15', title: 'Agents That Plan, Act and Recover', speaker: 'Kabir Menon', room: 'Seminar Hall', status: 'live' },
    { id: 'ag_04', day: 1, startsAt: '13:00', title: 'Build Lab: Tool-Calling & Memory', speaker: 'Sneha Iyer', room: 'Seminar Hall', status: 'upcoming' },
    { id: 'ag_05', day: 1, startsAt: '15:30', title: 'Ship It: Lightning Demos', speaker: 'Community', room: 'Seminar Hall', status: 'upcoming' },
    { id: 'ag_06', day: 2, startsAt: '09:30', title: 'Day Two Opening', speaker: 'Kabir Menon', room: 'Seminar Hall', status: 'upcoming' },
    { id: 'ag_07', day: 2, startsAt: '10:15', title: 'Agent Workflows in Depth', speaker: 'Dr. Anjali Rao', room: 'Seminar Hall', status: 'upcoming' },
    { id: 'ag_08', day: 2, startsAt: '13:00', title: 'Capstone Build Session', speaker: 'Sneha Iyer', room: 'Seminar Hall', status: 'upcoming' },
    { id: 'ag_09', day: 2, startsAt: '15:00', title: 'Closing & Awards', speaker: 'Community', room: 'Seminar Hall', status: 'upcoming' },
  ],
}

export const SEED_TEAMS: readonly Team[] = [
  {
    id: 'team_android',
    name: 'Android Bengaluru',
    leadName: 'Sneha Iyer',
    members: ['Rohan Gupta', 'Meera Nair', 'Arjun Rao', 'Divya Menon'],
  },
  {
    id: 'team_ai',
    name: 'AI & ML Circle',
    leadName: 'Kabir Menon',
    members: ['Ananya Iyer', 'Vikram Shah', 'Nisha Pillai', 'Sameer Khan'],
  },
  {
    id: 'team_web',
    name: 'Web Platform Guild',
    leadName: 'Ritika Shah',
    members: ['Karthik Reddy', 'Pooja Desai', 'Aditya Bose'],
  },
  {
    id: 'team_cloud',
    name: 'Cloud Native Chapter',
    leadName: 'Arjun Nair',
    members: ['Fatima Sheikh', 'Rahul Verma', 'Lakshmi Iyer', 'Tanvi Joshi', 'Zoya Khan'],
  },
]

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
