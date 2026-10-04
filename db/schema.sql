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
--
-- Two roles, because "can open the door" and "can run the event" are different
-- permissions. A volunteer at the gate needs to scan a badge and nothing else;
-- they do not need to change a credential, edit the programme, or walk away with
-- a spreadsheet of every registered SEN.
--
--   owner — everything, including staff management. Cannot be removed.
--   gate  — mark attendance, read the attendance log, read teams. Nothing else.
--
-- The default is `owner` on purpose: an account that existed before roles did
-- must not silently lose the ability to fix anything. Downgrading is an explicit
-- act through the Staff panel.
--
-- `active` rather than a delete, so disabling a volunteer who has walked off site
-- does not erase the name attached to audit rows they already produced.
-- -----------------------------------------------------------------------------
create table if not exists admins (
  id            uuid primary key default gen_random_uuid(),
  username      text        not null unique,
  display_name  text        not null,
  password_hash text        not null,
  role          text        not null default 'owner',
  active        boolean     not null default true,
  created_at    timestamptz not null default now()
);

-- Same upgrade-in-place reasoning as the SEN constraint above: a `create table if
-- not exists` is a no-op on an existing table, so without these an already-seeded
-- database would keep the old shape and every query would fail on a missing
-- column.
alter table admins add column if not exists role text not null default 'owner';
alter table admins add column if not exists active boolean not null default true;

alter table admins drop constraint if exists admins_role;
alter table admins
  add constraint admins_role check (role in ('owner', 'gate'));

-- Usernames are compared case-insensitively at login, so the unique index has to
-- be too — otherwise "Ankith" and "ankith" are two accounts and one of them
-- cannot be told apart in a list of staff.
create unique index if not exists admins_username_lower_idx on admins (lower(username));

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
-- Attendance — APPEND ONLY, AND PER DAY.
--
-- There is deliberately no updated_at and no status column. A record exists
-- because a barcode was scanned, and the only way to undo one is to delete the
-- row out of band.
--
-- `day` is which day of the event the scan belongs to. It was added because a
-- single unique index on attendee_id made attendance a once-in-a-lifetime event:
-- somebody who attends both days could only ever be marked once, and on day two
-- their badge came back "already checked in". Not everyone attends both days, so
-- a single flag cannot represent the event either.
--
-- The day is resolved by the SERVER from the calendar, never sent by the client.
-- A client that chose the day could misattribute a whole queue of scans by
-- toggling the wrong control, and the operator at the door should have nothing to
-- get wrong.
--
-- The unique index below is the real guarantee: even if two admins scan the same
-- badge simultaneously, the database rejects the second insert. Enforcing this in
-- the UI alone would leave a race that a real gate would hit.
-- -----------------------------------------------------------------------------
create table if not exists attendance (
  id          uuid primary key default gen_random_uuid(),
  sen         text        not null,
  attendee_id uuid        not null references attendees (id) on delete cascade,
  at          timestamptz not null default now(),

  -- Which day of the event. 1-based, matching `agenda.day`. Existing rows are
  -- backfilled to 1, which is what the server's own calendar resolution would
  -- have produced for them: every one was scanned before the event began.
  day         smallint    not null default 1,

  -- How the attendee was admitted:
  --   'qr'      — a scanned pass whose HMAC signature verified against the
  --               server key, proving the pass was issued by us
  --   'printed' — a bare SEN typed by staff or read from a printed barcode,
  --               where no signature is available
  --
  -- Persisted rather than merely logged, because "who was admitted on a
  -- hand-typed number" is exactly the question an audit needs to answer.
  method      text        not null default 'qr',
  constraint attendance_method check (method in ('qr', 'printed')),
  constraint attendance_day check (day >= 1)
);

/*
  `gate` is DROPPED, and it held nothing but a fiction.

  It was `text not null` with a single possible value, 'Gate A', written literally
  by the scan endpoint and shown to attendees as though it were a real place. There
  is one venue: Seminar Hall, Bengaluru. A column whose every value is a door that
  does not exist is not data, and it produced a visible "GATE A" on the attendee
  dashboard next to a real venue — which is the kind of thing that gets a bug
  report three weeks out.

  If a second entrance is ever added, add the column back then, with the value
  chosen per scan rather than hard-coded.

  Nothing of value is lost: every row held the same string.
*/
alter table attendance drop column if exists gate;

-- `create table if not exists` is a no-op when the table already exists, so a
-- database created before `method` or `day` was introduced would silently keep the
-- old shape and every insert would fail on the missing NOT NULL column. This makes
-- re-running the file upgrade it in place.
--
-- These come BEFORE the index changes below. An index on a column that does not
-- exist yet is a hard error, and `setup-db.mjs` runs statements in file order, so
-- the order here is load-bearing rather than cosmetic.
alter table attendance add column if not exists method text not null default 'qr';
alter table attendance drop constraint if exists attendance_method;
alter table attendance
  add constraint attendance_method check (method in ('qr', 'printed'));

alter table attendance add column if not exists day smallint not null default 1;
alter table attendance drop constraint if exists attendance_day;
alter table attendance add constraint attendance_day check (day >= 1);

/*
  The old index said one row per attendee FOREVER. Replaced rather than extended:
  keeping it would mean the second day's insert always conflicts, which is exactly
  the bug `day` exists to fix.

  Dropped explicitly because `create unique index if not exists` matches on the
  INDEX NAME, and the new index has a different one — so without the drop, both
  would exist and the old one would silently keep rejecting every second scan.
*/
drop index if exists one_attendance_per_attendee;

create unique index if not exists one_attendance_per_attendee_day
  on attendance (attendee_id, day);

-- Reads are almost always "everyone marked on day N", so the day leads the index.
create index if not exists attendance_day_idx on attendance (day, at);

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
-- Staff changes
--
-- Who created, demoted or disabled which staff account, and who authorised it.
--
-- Same reasoning as password_changes, applied to the other privileged act in the
-- portal. A volunteer account is a credential that can mark anyone present, so
-- "how did this account come to exist" has to have an answer after the fact.
--
-- `action` is the verb that was applied: 'created', 'role_changed', 'reset',
-- 'deactivated', 'reactivated'. Append-only.
-- -----------------------------------------------------------------------------
create table if not exists staff_changes (
  id         uuid primary key default gen_random_uuid(),
  admin_id   uuid        not null,
  subject_id uuid        not null,
  action     text        not null,
  detail     text,
  at         timestamptz not null default now()
);

create index if not exists staff_changes_subject_idx
  on staff_changes (subject_id, at desc);

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

/*
  Which day attendance scans are recorded against, when an owner says so.

  NULL — the normal state — means the server derives it from the calendar. That is
  the right default because it is the only option that cannot be misconfigured:
  nobody has to remember to switch it, and nobody can forget to.

  A number pins the active day regardless of the date. Two reasons it exists:

    - Testing. Before the event the calendar says "day 1", so there is otherwise no
      way to exercise the day-two scan path at all.
    - Running behind. If day two starts late, or day one overruns into the next
      morning, a human can say so instead of the portal quietly filing a morning's
      scans under the wrong heading.

  Owner-only. A `gate` account cannot read or set it — it is a control, not a
  preference.
*/
alter table events add column if not exists day_override smallint;

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