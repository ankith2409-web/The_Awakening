-- =============================================================================
-- THE AWAKENING — schema
--
-- Run this once against your Neon database:
--   psql "$DATABASE_URL" -f db/schema.sql
-- =============================================================================

-- gen_random_uuid() and pgcrypto live in these extensions.
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Attendees
--
-- `phone` and `sen` are UNIQUE at the database level, not just in application
-- code. That is deliberate: both are the identity used at the gate, and a
-- duplicate would make two people indistinguishable when scanned.
-- -----------------------------------------------------------------------------
create table if not exists attendees (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null,
  phone         text        not null unique,
  sen           text        not null unique,
  password_hash text        not null,
  created_at    timestamptz not null default now(),
  constraint attendees_phone_digits check (phone ~ '^[6-9][0-9]{9}$')
);

-- Relaxes the SEN format check.
--
-- The first draft demanded a 2-4 letter prefix followed by digits, which
-- rejected perfectly ordinary formats like 22CS1RE0123. SEN structure varies
-- by institution, so the constraint now only enforces "alphanumeric and
-- contains a digit" — the unique index and the lookup are the real gates.
--
-- Written as drop-then-add so re-running this file upgrades an existing
-- database instead of silently keeping the stricter rule.
alter table attendees drop constraint if exists attendees_sen_format;
alter table attendees
  add constraint attendees_sen_format
  check (sen ~ '^[A-Z0-9]{4,24}$' and sen ~ '[0-9]');

create index if not exists attendees_sen_lower_idx on attendees (upper(sen));

-- -----------------------------------------------------------------------------
-- Admins — a separate door from attendees, with separate credentials.
-- -----------------------------------------------------------------------------
create table if not exists admins (
  id            uuid primary key default gen_random_uuid(),
  username      text        not null unique,
  display_name  text        not null,
  password_hash text        not null,
  created_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Sessions
--
-- Only a SHA-256 HASH of the cookie token is stored. A database leak therefore
-- yields nothing an attacker can present as a session.
-- -----------------------------------------------------------------------------
create table if not exists sessions (
  token_hash text primary key,
  kind       text        not null,
  subject_id uuid        not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint sessions_kind check (kind in ('attendee', 'admin'))
);

create index if not exists sessions_expiry_idx on sessions (expires_at);

-- -----------------------------------------------------------------------------
-- Attendance — APPEND ONLY.
--
-- There is deliberately no updated_at and no status column. A record exists
-- because a barcode was scanned, and the only way to undo one is to delete the
-- row out of band.
--
-- The unique index below is the real guarantee: even if two admins scan the
-- same badge simultaneously, the database rejects the second insert. Enforcing
-- this in the UI alone would leave a race that a real gate would hit.
-- -----------------------------------------------------------------------------
create table if not exists attendance (
  id          uuid primary key default gen_random_uuid(),
  sen         text        not null,
  attendee_id uuid        not null references attendees (id) on delete cascade,
  gate        text        not null,
  at          timestamptz not null default now(),

  -- How the attendee was admitted:
  --   'qr'      — a scanned pass whose HMAC signature verified against the
  --               server key, proving the pass was issued by us
  --   'printed' — a bare SEN typed by staff or read from a printed barcode,
  --               where no signature is available
  --
  -- Persisted rather than merely logged, because "who was admitted on a
  -- hand-typed number" is exactly the question an audit needs to answer.
  method      text        not null default 'qr',
  constraint attendance_method check (method in ('qr', 'printed'))
);

create unique index if not exists one_attendance_per_attendee
  on attendance (attendee_id);

-- `create table if not exists` is a no-op when the table already exists, so a
-- database created before `method` was introduced would silently keep the old
-- shape and every insert would fail on the missing NOT NULL column. This makes
-- re-running the file upgrade it in place.
alter table attendance add column if not exists method text not null default 'qr';
alter table attendance drop constraint if exists attendance_method;
alter table attendance
  add constraint attendance_method check (method in ('qr', 'printed'));

-- -----------------------------------------------------------------------------
-- Admin password changes
--
-- Password recovery is ADMIN-MEDIATED: an attendee who forgets their password
-- asks an organiser at the desk, who sets a new one. That replaced a
-- self-service reset which was unverified — knowing a phone number was enough to
-- take over that account — so the only remaining path to a password change is
-- now a privileged, authenticated action.
--
-- Which is exactly why this table exists. The old flow recorded every attempt,
-- including the failed ones, because an unverified endpoint can be attacked
-- silently. The new one can only be reached by someone holding an admin
-- session, so the useful record is not "who tried" but "who changed a password,
-- for whom, and when". That is a security-relevant privileged action and it
-- should be attributable.
--
-- Append-only, like attendance. No updated_at, no status: a change happened.
-- -----------------------------------------------------------------------------
create table if not exists password_changes (
  id          uuid primary key default gen_random_uuid(),
  attendee_id uuid        not null references attendees (id) on delete cascade,
  admin_id    uuid        not null,
  at          timestamptz not null default now()
);

create index if not exists password_changes_attendee_idx
  on password_changes (attendee_id, at desc);

-- -----------------------------------------------------------------------------
-- Password-reset attempts
--
-- RETAINED, BUT UNUSED. This backed the removed self-service reset endpoint.
-- The table is left in place rather than dropped: dropping it would be a
-- destructive schema change to a live database for no benefit, and the rows it
-- holds are an accurate historical record of the probing that endpoint received.
-- It is no longer written to or read by any route.
-- -----------------------------------------------------------------------------
create table if not exists password_reset_attempts (
  id         bigserial primary key,
  phone      text        not null,
  ip         text        not null,
  created_at timestamptz not null default now()
);

create index if not exists password_reset_attempts_phone_idx
  on password_reset_attempts (phone, created_at desc);

create index if not exists password_reset_attempts_ip_idx
  on password_reset_attempts (ip, created_at desc);

-- -----------------------------------------------------------------------------
-- Programme — event, agenda, teams.
-- -----------------------------------------------------------------------------
create table if not exists events (
  id        text primary key,
  name      text        not null,
  tagline   text        not null,
  organiser text        not null,
  -- `date` is day one. `end_date` exists because this is a two-day event, and
  -- collapsing "14th and 15th" into a single date would misstate when it runs.
  -- Equal to `date` for a single-day event.
  date      date        not null,
  end_date  date,
  -- The institution hosting the event, distinct from the community group
  -- running it (GDG). Both are shown on the attendee dashboard.
  organiser_host text,
  venue     text        not null,
  city      text        not null,
  phase     text        not null default 'registration',
  capacity  integer     not null,
  constraint events_phase check (phase in ('registration', 'live', 'completed'))
);

-- `create table if not exists` is a no-op on an existing table, so these make
-- re-running the file upgrade a database created before the columns existed.
alter table events add column if not exists end_date date;
alter table events add column if not exists organiser_host text;

create table if not exists agenda (
  id         text primary key,
  event_id   text        not null references events (id) on delete cascade,
  -- Which day of the event this session belongs to. A two-day programme cannot
  -- be a flat list without repeating the date on every row.
  day        smallint     not null default 1,
  starts_at  text        not null,
  title      text        not null,
  speaker    text        not null,
  room       text        not null,
  status     text        not null default 'upcoming',
  sort_order integer     not null,
  constraint agenda_status check (status in ('done', 'live', 'upcoming')),
  constraint agenda_day check (day >= 1)
);

alter table agenda add column if not exists day smallint not null default 1;

create index if not exists agenda_event_order_idx on agenda (event_id, sort_order);

create table if not exists teams (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  lead_name text not null,
  members   jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0
);