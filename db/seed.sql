-- =============================================================================
-- Seed data for THE AWAKENING.
--
-- Idempotent: every insert is guarded, so re-running will not duplicate rows.
-- Replace these values with your real roster — this is data, not logic.
-- =============================================================================

-- Runs 13-14 October 2026, two days, in the Auditorium on the Amity
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
  '2026-10-13',
  '2026-10-14',
  'Auditorium',
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

-- Day 1 is the 13th, day 2 the 14th.
--
-- No times and no rooms, because there are none. The previous version of this table
-- had nine rows with 09:30 openings and a "Dr. Anjali Rao" speaking, all of it invented.
-- A schedule that does not exist is worse than no schedule: somebody plans their day
-- around it and then finds the room empty.
--
-- Both speakers are on both days, so every row carries the same pair. Repeating it per
-- row rather than keeping a separate speakers list is deliberate — it means the day
-- heading and its speakers can never drift apart.
insert into agenda (id, event_id, day, starts_at, title, speaker, room, status, sort_order)
values
  ('ag_01', 'evt_awakening_2026', 1, null, 'Technical sessions',            'Aryan Gandhi & Tanisha Sharma', null, 'upcoming', 1),
  ('ag_02', 'evt_awakening_2026', 1, null, 'Ecosystem exploration',        'Aryan Gandhi & Tanisha Sharma', null, 'upcoming', 2),
  ('ag_03', 'evt_awakening_2026', 1, null, 'Challenge Brief & Rules',      'Aryan Gandhi & Tanisha Sharma', null, 'upcoming', 3),
  ('ag_04', 'evt_awakening_2026', 2, null, 'Challenge kick-off',           'Aryan Gandhi & Tanisha Sharma', null, 'upcoming', 4),
  ('ag_05', 'evt_awakening_2026', 2, null, 'Idea formation',               'Aryan Gandhi & Tanisha Sharma', null, 'upcoming', 5),
  ('ag_06', 'evt_awakening_2026', 2, null, 'Team setup',                    'Aryan Gandhi & Tanisha Sharma', null, 'upcoming', 6),
  ('ag_07', 'evt_awakening_2026', 2, null, 'Project development',           'Aryan Gandhi & Tanisha Sharma', null, 'upcoming', 7),
  ('ag_08', 'evt_awakening_2026', 2, null, 'Demonstrations',                'Aryan Gandhi & Tanisha Sharma', null, 'upcoming', 8),
  ('ag_09', 'evt_awakening_2026', 2, null, 'Evaluation',                    'Aryan Gandhi & Tanisha Sharma', null, 'upcoming', 9),
  ('ag_10', 'evt_awakening_2026', 2, null, 'Closing',                       'Aryan Gandhi & Tanisha Sharma', null, 'upcoming', 10)
on conflict (id) do update set
  day        = excluded.day,
  starts_at  = excluded.starts_at,
  title      = excluded.title,
  speaker    = excluded.speaker,
  room       = excluded.room,
  sort_order = excluded.sort_order;

-- Rows from the previous nine-item timetable that are not in the list above. Without
-- this, `on conflict do nothing` semantics leave yesterday's fabricated schedule on
-- screen next to today's real one.
delete from agenda where event_id = 'evt_awakening_2026'
  and id not in ('ag_01','ag_02','ag_03','ag_04','ag_05','ag_06','ag_07','ag_08','ag_09','ag_10');