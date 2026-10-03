-- =============================================================================
-- Seed data for THE AWAKENING.
--
-- Idempotent: every insert is guarded, so re-running will not duplicate rows.
-- Replace these values with your real roster — this is data, not logic.
-- =============================================================================

-- Runs 14–15 October 2026, two days, in the Seminar Hall on the Amity
-- University Bengaluru campus.
--
-- `venue` and `city` were previously the wrong way round in this file: the
-- venue column held 'Bengaluru' and the city column held 'India'.
insert into events (
  id, name, tagline, organiser, organiser_host, date, end_date, venue, city, phase, capacity
)
values (
  'evt_awakening_2026',
  'THE AWAKENING',
  'AI agents — built by you',
  'Google Developer Groups',
  'Amity University Bengaluru',
  '2026-10-14',
  '2026-10-15',
  'Seminar Hall',
  'Bengaluru',
  'registration',
  480
)
on conflict (id) do update set
  name           = excluded.name,
  tagline        = excluded.tagline,
  organiser      = excluded.organiser,
  organiser_host = excluded.organiser_host,
  date           = excluded.date,
  end_date       = excluded.end_date,
  venue          = excluded.venue,
  city           = excluded.city,
  phase          = excluded.phase,
  capacity       = excluded.capacity;

-- Day 1 is the 14th, day 2 the 15th. Change the `day` value on a row to move a
-- session between the two days.
insert into agenda (id, event_id, day, starts_at, title, speaker, room, status, sort_order)
values
  ('ag_01', 'evt_awakening_2026', 1, '09:30', 'Registration & Badges',   'GDG Bengaluru',   'Seminar Hall', 'done',     1),
  ('ag_02', 'evt_awakening_2026', 1, '10:00', 'Opening: What Awakens',    'Dr. Anjali Rao',  'Seminar Hall', 'done',     2),
  ('ag_03', 'evt_awakening_2026', 1, '11:15', 'Agents That Plan, Act and Recover', 'Kabir Menon', 'Seminar Hall', 'live',    3),
  ('ag_04', 'evt_awakening_2026', 1, '13:00', 'Build Lab: Tool-Calling & Memory',  'Sneha Iyer',  'Seminar Hall', 'upcoming', 4),
  ('ag_05', 'evt_awakening_2026', 1, '15:30', 'Ship It: Lightning Demos', 'Community',      'Seminar Hall', 'upcoming', 5),
  ('ag_06', 'evt_awakening_2026', 2, '09:30', 'Day Two Opening',          'Kabir Menon',    'Seminar Hall', 'upcoming', 6),
  ('ag_07', 'evt_awakening_2026', 2, '10:15', 'Agent Workflows in Depth', 'Dr. Anjali Rao',  'Seminar Hall', 'upcoming', 7),
  ('ag_08', 'evt_awakening_2026', 2, '13:00', 'Capstone Build Session',   'Sneha Iyer',     'Seminar Hall', 'upcoming', 8),
  ('ag_09', 'evt_awakening_2026', 2, '15:00', 'Closing & Awards',         'Community',      'Seminar Hall', 'upcoming', 9)
on conflict (id) do update set
  day        = excluded.day,
  starts_at  = excluded.starts_at,
  title      = excluded.title,
  speaker    = excluded.speaker,
  room       = excluded.room,
  sort_order = excluded.sort_order;

-- Teams: name, lead, members. Inserted in a fixed order so `sort_order`
-- controls the display sequence.
insert into teams (name, lead_name, members, sort_order)
select * from (values
  ('Android Bengaluru',      'Sneha Iyer',  '["Rohan Gupta","Meera Nair","Arjun Rao","Divya Menon"]'::jsonb, 1),
  ('AI & ML Circle',         'Kabir Menon', '["Ananya Iyer","Vikram Shah","Nisha Pillai","Sameer Khan"]'::jsonb, 2),
  ('Web Platform Guild',     'Ritika Shah', '["Karthik Reddy","Pooja Desai","Aditya Bose"]'::jsonb, 3),
  ('Cloud Native Chapter',   'Arjun Nair',  '["Fatima Sheikh","Rahul Verma","Lakshmi Iyer","Tanvi Joshi","Zoya Khan"]'::jsonb, 4)
) as t(name, lead_name, members, sort_order)
where not exists (select 1 from teams where teams.name = t.name);