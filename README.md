# THE AWAKENING — Access Portal

Attendee registration, a per-person QR entry pass, live event status, and a
separate admin portal for scanning SEN barcodes at the door and resetting an
attendee's password.

**AI agents — built by you.** A Fetch AI event by Google Developer Groups, hosted
by Amity University Bengaluru, Seminar Hall, 14–15 October 2026.

**Live:** https://the-awakening-portal.vercel.app

React 19 · TypeScript · Vite 8 · Tailwind CSS v4 · React Router 7 · Neon
Postgres · Vercel serverless functions

---

## Quick start

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and TICKET_SECRET
npm run db:setup            # apply schema + seed, create the admin account
npm run dev                 # http://localhost:5173
```

`npm run dev` uses an in-memory mock backend and needs no database. To run
against the real one, set `VITE_USE_MOCK_API=false` and use the local API harness:

```bash
node dev-api.mjs            # serves the serverless function on :3000
```

| Script                | Purpose                                                   |
| --------------------- | --------------------------------------------------------- |
| `npm run dev`         | Client with the mock backend, no database                 |
| `npm run build`       | Typecheck, client build, serverless bundle                |
| `npm run db:setup`    | Apply `db/schema.sql` and `db/seed.sql`, create the admin  |
| `npm run lint`        | oxlint                                                    |
| `npm run test:api`    | End-to-end suite against a running API                    |
| `npm run test:live`   | The live-update wiring, asserted from source              |
| `npm run prepublish`  | Secret scan — run before every push                       |

## Configuration

| Variable            | Scope  | Notes                                                    |
| ------------------- | ------ | -------------------------------------------------------- |
| `DATABASE_URL`      | server | Neon **pooled** connection string                        |
| `TICKET_SECRET`     | server | ≥16 chars, unique per deployment; signs the QR payload   |
| `ADMIN_USERNAME`    | setup  | Read only by `npm run db:setup`                          |
| `ADMIN_PASSWORD`    | setup  | Read only by `npm run db:setup`; stored only as a hash   |
| `VITE_USE_MOCK_API` | client | `false` for the real backend                              |
| `VITE_API_BASE_URL` | client | `/api` — same origin, so no CORS setup is required       |

Admin credentials are never committed. `npm run db:setup` creates the admin row
from `ADMIN_USERNAME` / `ADMIN_PASSWORD`; only the bcrypt hash is stored.

---

## Architecture

```
src/
  domain/                Types, rules and validation — no React, no transport
    types.ts               Attendee, EventInfo, Team, CheckIn, error codes
    portal-api.ts          The PortalApi contract
    phone.ts               Indian mobile + SEN normalisation and validation
  api/                   Two interchangeable implementations of that contract
    http-portal.ts         Real HTTP (credentials: 'include')
    mock-portal.ts         In-memory backend, same signatures
    index.ts               THE SWITCH
  auth/                  AttendeeProvider and AdminProvider — two separate doors
    liveEvent.ts           What a poll compares, so an unchanged event is free
    probeSession.ts        A failed probe is "unknown", not "logged out"
  lib/
    exportAttendance.ts    SEN-only CSV download
    motion.ts              Stagger cap, the one place it is defined
  lib/roster/             Dependency-free .csv and .xlsx reader for the guest list
    parse.ts                Header matching by name, SEN shape check, row problems
  components/            Design-system primitives
    EventMark.tsx          The mark and its glitch cycle
    BarcodeScanner.tsx     Camera scanner (ZXing, lazy-loaded)
    SiteFooter.tsx         Host block, connect links, legal line
    Button.tsx  Field.tsx  Typography.tsx  QrTicket.tsx  Skeleton.tsx  …
  views/
    LandingView.tsx        The public front door
    AuthViews.tsx          Log in + Register
    DashboardView.tsx      QR pass, attendance, event status
    admin/
      AdminLoginView.tsx   The separate staff door
      AdminPortalView.tsx  Tabs: Scan, Attendance, People, Teams, Event
      AttendeeDirectory.tsx  Find an attendee, set their password

server/                The backend. Deliberately NOT named `api/` — see below.
  [...route].ts          All endpoints, one serverless function
  _lib/
    db.ts                 Pooled pg client
    auth.ts               bcrypt, sessions, httpOnly cookies
    http.ts               ApiError taxonomy, JSON and body parsing
    identifiers.ts        Phone/SEN normalisation (mirrors src/domain/phone.ts)
    ticket.ts             HMAC ticket signing, constant-time verification
    reset.ts              Housekeeping for the retired reset-attempt ledger

db/
  schema.sql           Tables, unique indexes, CHECK constraints (idempotent)
  seed.sql             Event, agenda, teams (idempotent)

scripts/               Build, database setup, staff accounts, test suites, load tooling
```

### Why the backend lives in `server/`, not `api/`

Vercel only auto-builds an `api/` directory for Next.js. With this project
detected as Vite it skipped the functions entirely and served the SPA shell for
every `/api/*` path — returning **HTTP 200 with HTML**, so the failure presented
as a working endpoint rather than a missing one. Setting `"framework": null`
does not change this, and leaving the source in `api/` made Vercel build a
second, unstripped copy of the function that shadowed the correct bundle.

`scripts/build-vercel.mjs` therefore emits a
[Build Output API v3](https://vercel.com/docs/build-output-api-v3) directory
explicitly, and the source lives in `server/` so there is exactly one build
path. The bundle is CommonJS with `pg` and `bcryptjs` inlined, because Vercel's
launcher `require()`s it.

The handler uses only `req.url`, `req.headers` and `res.statusCode`. It does not
touch `req.query`, `req.cookies` or a `res.status()` helper — a Build Output
function receives a plain Node `IncomingMessage`/`ServerResponse`, and leaning on
the Express-shaped conveniences throws at runtime only in production.

`dev-api.mjs` is a test-only harness that replays the request body and adds
**nothing** to the request or response, for the same reason. Faking those
properties locally lets runtime-only defects through.

---

## Data model

Neon Postgres, region `ap-southeast-1`, pooled connection string.

| Table                      | Notes                                                        |
| -------------------------- | ------------------------------------------------------------ |
| `attendees`                | unique on `phone` and `sen`; both CHECK-constrained            |
| `attendance`               | append-only; unique on `(attendee_id, day)`; **no `gate` column** |
| `sessions`                 | SHA-256 token hash, `kind`, `expires_at`; expired rows purged |
| `admins`                   | bcrypt hashes, `role` (`owner` / `gate`), `active`             |
| `staff_changes`            | append-only audit of who changed which staff account          |
| `password_changes`         | append-only audit of admin-mediated password changes          |
| `password_reset_attempts`  | retired; retained as a record of the old endpoint's probing   |
| `event_roster`             | the guest list an organiser uploaded; SEN is the key          |
| `events`                   | one row; `day_override` pins the live day, `locked_days` closes days |
| `agenda`                   | per-event items with `day`, `sort_order` and `status`         |
| `teams`                    | read-only; there is no team write route                       |

`db/schema.sql` is idempotent and safe to re-run — the SEN format check is
written as drop-then-add, so re-running upgrades an existing database rather than
failing on it.

Attendees self-register, so there is no roster to import. Teams and the agenda
are placeholders seeded by `db/seed.sql`; replace them there:

```sql
update teams set name = '…', lead_name = '…', members = array['…'] where id = '…';
update agenda set title = '…', speaker = '…', room = '…', starts_at = '…';
```

---

## API reference

All routes are mounted under `/api`. Errors return `{ code, message }`, where
`code` is drawn from the closed `PortalErrorCode` set.

| Method  | Path                       | Body                                  | Auth            |
| ------- | -------------------------- | ------------------------------------- | --------------- |
| `GET`   | `/event`                   | —                                     | public          |
| `GET`   | `/teams`                   | —                                     | public          |
| `GET`   | `/attendee/session`        | —                                     | optional        |
| `POST`  | `/attendee/login`          | `{ name, phone, password, remember }` | —               |
| `POST`  | `/attendee/register`       | `{ name, phone, sen }`                | —               |
| `POST`  | `/attendee/verify-password`| `{ password }`                         | attendee        |
| `POST`  | `/attendee/change-password`| `{ currentPassword, newPassword }`      | attendee        |
| `POST`  | `/attendee/logout`         | —                                     | attendee        |
| `GET`   | `/attendee/ticket`         | —                                     | attendee        |
| `GET`   | `/attendee/attendance`     | —                                     | attendee        |
| `GET`   | `/admin/session`           | —                                     | optional        |
| `POST`  | `/admin/login`             | `{ username, password }`              | —               |
| `POST`  | `/admin/logout`            | —                                     | admin           |
| `GET`   | `/admin/attendees`         | —                                     | **owner**       |
| `POST`  | `/admin/attendees`         | `{ name, phone, sen, password }`      | **owner**       |
| `POST`  | `/admin/attendees/password`| `{ sen, password }`                   | **owner**       |
| `GET`   | `/admin/attendance`        | —                                     | admin           |
| `POST`  | `/admin/attendance`        | `{ sen }`                             | admin           |
| `GET`   | `/admin/roster`            | —                                     | **owner**       |
| `GET`   | `/admin/roster/rows`       | —                                     | **owner**       |
| `POST`  | `/admin/roster`            | `{ rows, registrationMode }`          | **owner**       |
| `DELETE`| `/admin/roster`            | —                                     | **owner**       |
| `PATCH` | `/admin/agenda/:id`        | `{ status }`                          | **owner**       |
| `PATCH` | `/admin/event`             | `{ phase, dayOverride, lockedDays, registrationMode }` | **owner** |

There is **no** `/admin/staff` route in either direction. Staff accounts are
provisioned by `scripts/manage-staff.mjs`; see
[one gate credential](#there-is-one-gate-credential-and-it-is-provisioned-from-the-command-line).

There is deliberately **no** `/attendee/password/reset` route. See
[Password recovery is admin-mediated](#password-recovery-is-admin-mediated).

Two independent providers, not one: attendee and admin are **separate doors** with
separate credentials, and neither can authorise the other. An anonymous call to
any `/admin/*` route returns 403, and a `gate` account calling an owner-only route
gets the same 403 — see [Two kinds of staff account](#two-kinds-of-staff-account).

`POST /admin/attendees/password` returns `{ attendee: { id, name, sen },
sessionsRevoked: true }`. It is the only password-change path in the portal, and
its three writes — new hash, revoked sessions, audit row — run in a single
transaction so a partial commit cannot leave a changed password with surviving
sessions.

`PATCH /admin/agenda/:id` returns the single updated `AgendaItem`;
`PATCH /admin/event` returns the whole `EventInfo`, which is what the caller
replaces its state with. It takes `phase`, `dayOverride`, `lockedDays` and
`registrationMode` independently, so setting one does not clobber the others — which
is what makes each control safe to retry on a bad connection at a busy door.
`registrationMode` is validated rather than coerced: an unrecognised value returns
400 and nothing is written, because that string decides who may register and a
stored value matching none of the three checks would leave a portal where nobody can
register and nothing says why.

`POST /admin/attendees` returns `{ attendee }` and **no session** — the person is not
at that computer. It is the only route that can bypass the guest list, so it is
owner-only, audited in `password_changes`, and validated by exactly the functions the
public registration form uses. See
[Adding somebody by hand](#adding-somebody-by-hand).

`GET /admin/roster` deliberately does **not** repeat `registration_mode`. The client
already holds it on `EventInfo`, and a second copy would be a second fact to go
stale. Attendance rows come back camelCase
(`attendeeId`) so the admin log can resolve each row to a person, and carry `day`
so it can be grouped.

`GET /attendee/attendance` returns `{ records, activeDay, totalDays, overridden }`
— an array, not a single record. It used to return one row or `null`; returning
"the first row" now would tell somebody who came on day two that they arrived on
day one. `totalDays` is included so the dashboard can render a row for a day with no
record yet, which is what turns an absence the attendee can read as *not yet* rather
than as nothing at all. No session is still `null`, so "nobody signed in" stays
distinguishable from "signed in, not marked".

---

## Core behaviour

### Attendance is scan-only and append-only

`POST /admin/attendance` is the only route that can create a record. There is no
update, no delete, and no edit control anywhere in the UI — a mistake is
corrected by a fresh scan, not by amending history.

**One record per attendee per day**, and that is the fix for a bug that made
attendance a once-in-a-lifetime event. With a unique index on `attendee_id`, a
person who attended both days could only ever be marked once — on the morning of
day two their badge came back *already checked in*. And because not everyone comes
on both days, a single flag cannot represent this event either: it cannot say who
was there yesterday and who is here today.

The write is a single atomic statement guarded by a unique index:

```sql
insert into attendance (sen, attendee_id, method, day)
select sen, id, $2, $3 from attendees where id = $1
on conflict (attendee_id, day) do nothing
returning id, sen, attendee_id as "attendeeId", at, method, day
```

`create unique index one_attendance_per_attendee_day on attendance (attendee_id, day)`
is the real guard, so two scanners hitting the same badge at the same instant cannot
both insert. A SELECT-then-INSERT would leave a race window there.

The old index is **dropped**, not extended. `create unique index if not exists`
matches on the index NAME, so a differently-named replacement would have left both
in place and the old one would have silently kept rejecting every second-day scan.

A SEN matching no registered attendee is rejected, so the roll cannot fill with
people who never registered.

**There is no `gate` column, and there never should have been.** It was
`text not null` with exactly one possible value, `Gate A`, written literally by the
scan route and shown to attendees as though it were a real place. There is one
venue — Seminar Hall — and a column whose every value is a door that does not exist
is not data. It was displayed next to the real venue on the attendee dashboard, and
in the admin log beside every row. If a second entrance is ever added, the column
goes back then, with the value chosen per scan rather than hard-coded.

#### Which day a scan belongs to

**The server decides. The client never sends a day.**

A day picker in the admin UI sounds friendlier, but it is one control that, left on
the wrong setting, files an entire morning's scans under the wrong heading — and
nobody finds out until the export is read. Deriving it from the date means there is
nothing at the door to get wrong, and the operator's job stays exactly what it was:
scan the badge.

| Situation        | Resolves to     |
| ---------------- | --------------- |
| Before the event | Day 1           |
| 14 October       | Day 1           |
| 15 October       | Day 2           |
| After the event  | The last day    |

Not "no day". Every test scan anyone has run against this portal happens outside the
window, so refusing to resolve one would mean the gate is unusable for testing.

**Future days are locked**, and there is no check for it anywhere in the code. The
scan endpoint records the active day and nothing else, so the only way to record
day two is for the server to already believe it is day two. The rule holds *by
construction* rather than by a predicate somebody could bypass — or, worse, believe
is being enforced somewhere else. An earlier draft exposed a `canMark(day)`
predicate for this; it was never called, so it was deleted and the rule documented
instead.

#### The override, and why it exists

`events.day_override` pins the active day regardless of the date. Owner-only, and
left on `Auto` — the normal state — between events. Two reasons it is there:

- **Testing.** Before the event the calendar says day one, so there is otherwise no
  way to exercise the day-two scan path at all.
- **A schedule that has slipped.** If day two starts late, or day one overruns into
  the next morning, a human can say so instead of the portal quietly filing a
  morning's scans under the wrong heading.

It works in both directions: pinning day one on the morning of day two is how you
record a scan you missed yesterday.

#### One timezone decision that matters

Bengaluru is UTC+05:30 with no daylight saving. Computing "what day is it here" by
subtracting 86,400,000 ms from a UTC instant works right up until it does not, and
when it does not every morning scan is filed under the previous day — for both
days, silently, with no error anywhere.

So `calendarDay` formats the date in `Asia/Kolkata` and asks the runtime what day it
actually is. `test:day` pins fixed dates including the exact rollover minute in both
directions: 23:59 in Bengaluru is still day one, one second later it is day two. A
test that only checked "today" would pass for months and then be wrong on the morning
of the event.

Related, and caught the same way: node-pg turns a Postgres `DATE` into a JS `Date`
at local midnight, whose `toString()` is not ISO. `Date.parse` returned `NaN`,
`totalDaysFor` silently floored to one day, and a two-day event presented itself as
a one-day one — with every downstream number wrong and nothing reporting it. So
both dates are cast with `to_char` in SQL, and `totalDaysFor` *rejects* anything
that is not `YYYY-MM-DD` rather than coercing it. Accepting a `Date` would have
hidden the next mistake of the same shape.

#### What each surface shows

| Surface             | Day handling                                              |
| ------------------- | --------------------------------------------------------- |
| Scan panel          | "Recording for **Day 1 of 2**", always visible            |
| Scan confirmation   | "Marked for day 1", plus time and admission method         |
| Attendance log      | One day, named in the panel title — no "all days"          |
| Desk roster         | A `D1` / `D2` badge per attendee                           |
| Attendee dashboard  | One row per day, marked or not, with today called out      |
| SEN export          | Per day, with the day in the filename                      |

#### One day control, not two

The log and the export were once separate: a **Day / All days** switch in the log
header, and a `<select>` beside the export button. They could disagree, and reading
the log for day one and then exporting day two because the other control still said
day two is precisely the silent mistake per-day attendance was meant to prevent.

So there is **one** selection — a segmented `1 / 2` pair in the page's action row —
and both the log and the export follow it. It sits in the action row rather than
inside the log header because that row is visible from every tab, so somebody who
wants day one exported without opening the log does not have to go and set it
somewhere they cannot see.

There is no "all days" view either. Two days are two lists: interleaving them by
clock time buries "who came today" between yesterday's rows, and a combined count at
the top reads as a total for the event when it is two separate figures. The export
label repeats the day — `Export SEN — day 2 (14)` — so the basis of the file is never
unstated.

#### Looking at one day, marking into another

That single control raised a trap, and it is worth writing down because the fix is
not obvious.

Which day you are **looking at** is the operator's choice. Which day a scan is
**recorded against** is the server's, from the calendar. Nothing at the door sets the
second one, and that is deliberate — a picker there can misfile an entire morning's
scans silently.

So switch the control to Day 2 on the morning of Day 1, scan somebody, and this
happens: the scan succeeds into Day 1, the confirmation says *"Marked for day 1"*,
and the Attendance tab then shows *"Nobody marked for day 2 yet"*. The person is
recorded and invisible. Reported as **"attendance is not marking"** — which is the
one conclusion the confirmation panel directly contradicts.

Two changes, and the second is the real one:

- **A successful scan moves the view to the day it actually landed on.** Following
  the record beats explaining it: the operator scans, and the row they just created
  is on screen. In normal operation the two days already match and this never fires.
  A *failed* scan moves nothing, because there is no record to follow.
- **The scan panel warns when the two disagree**, before anyone scans — and for an
  owner it names where the recording day is actually set (Programme → Attendance
  Day), because that control being on a different tab under a different name is the
  other half of why this was confusing.

#### Closing a day

`events.locked_days` refuses **new** marks for a day an owner has closed. Programme
→ Close Attendance, one toggle per day.

It exists because of append-only. There is no edit and no delete anywhere in this
product, so once a day's SEN list has gone out for certificates, a late scan cannot
be corrected — the record is wrong permanently and no route removes it. Locking the
day is the only honest answer available, and an honest one: it stops new marks
rather than pretending an existing mark can be amended.

**Locking hides nothing.** The log, the roster badges and the SEN export all still
show a locked day in full — verified, not assumed. Only new marks are refused. A lock
that also hid the record of who came would trade a small problem for a much worse
one.

Deliberately **not** merged with `day_override`. That moves the present forward; this
closes a day behind you. They are pressed at opposite moments — one in the morning,
one at the end — and a single control whose meaning depends on when you touched it
is how a day gets locked by accident.

The write sends the whole intended set rather than a toggle, so a retry on a bad
connection cannot reopen a day the organiser meant to close.

Owner-only, like the override. A `gate` account can already mark whoever walks
through the door on the live day, but letting a volunteer reopen a day that has
already been exported would let them add names to a list that is already gone. When
the live day is closed the scan panel says so and disables the scanner, rather than
letting a queue discover it one refusal per badge — twelve identical errors read as
a broken scanner, when it is working exactly as configured.

The attendee dashboard changed most in meaning. It used to say "Attendance Marked"
once. That told somebody who came on day two that they had been marked — full stop —
and told somebody who came on day one only that they were marked for an event with a
second day still to run. Both readings are wrong, and the second is wrong in the
direction that matters: they turn up on day two expecting nothing to be needed.

That also changed the dashboard's **polling**, which is easy to miss. It stopped as
soon as any record existed, which was correct while attendance was
once-in-a-lifetime. With a record per day, an attendee marked on day one would have
their polling stop that morning and sit watching an empty day two until they
manually reloaded — after walking through the gate again. It now waits for a record
for *today*.

#### Export

**Export** downloads a CSV of SEN numbers for **one day** — one value per row, no
header, no name, no phone, no time, no day column. The day is a required argument
rather than a default, and it is in the filename (`…-day-2-attendance.csv`).

With a record per person per day, "the SENs" is ambiguous: everyone who came at all,
or everyone who came today? Both are plausible and produce different files, so
picking the wrong one silently is how a certificate list ends up with the wrong
names on it. Two days are two files, produced deliberately. Somebody who attends
both appears once in each, which is correct — each file answers "who was in the room
on the day this was taken".

The header is omitted deliberately: the file is meant to be pasted into a column or
uploaded to a system that already knows what the values are, where a header row
would become a bogus entry. CSV rather than `.xlsx` because it opens natively in
Excel, needs no library, cannot break on a malformed cell, and carries a UTF-8 BOM
so Excel detects the encoding.

### Gate signature verification

The QR encodes `SEN.hmac(SEN)`, and the gate verifies it.

| Payload          | Admitted as         | Meaning                                    |
| ---------------- | ------------------- | ------------------------------------------ |
| Valid signature  | `method: 'qr'`      | The pass was issued by us for this SEN     |
| Bare SEN         | `method: 'printed'` | Staff vouched for it — typed or printed    |

A forged signature is downgraded to `printed`, never rejected, so the door never
stalls on a pass whose QR will not scan. The distinction is persisted in
`attendance.method` and shown in the admin log's **Via** column, because "who was
admitted on a hand-typed number" is the question an audit needs answered.

In production the signing key lives only on the server (`TICKET_SECRET`); the
client never sees it, and verification uses a constant-time compare. The
signature does not authorise attendance — the admin session does — it prevents a
screenshot of someone else's pass being edited into a different SEN before
scanning.

### The scan confirmation

A successful scan shows who was marked, their SEN, and how they were admitted.

Three decisions, each a correction of something that was wrong:

- **It is rendered at all.** A successful scan previously set state that nothing
  in the tree ever read, so every scan confirmed itself silently and the only
  thing on screen was the red error banner — the one thing that should mean
  something went wrong.
- **It is not red.** The accent colour is reserved for failure; a success in red
  makes a working gate look broken. It is `role="status"` with
  `aria-live="polite"`, so a screen reader announces it without interrupting.
- **It does not time out.** It used to auto-dismiss after three seconds, which is
  short enough to vanish before an operator has read the name back to the person
  in front of them. It now persists until the next scan replaces it, and clears
  the instant a new scan begins so a stale name is never on screen beside the
  next attendee.

### Camera scans do not steal focus

Returning focus to the SEN field after a camera scan raised the on-screen
keyboard over the camera preview on a phone, so the operator lost the view they
were scanning with. Focus now returns only after a typed entry, where it helps: a
USB barcode gun behaves like fast typing followed by Enter, so the next code
should go straight in.

### Name validation, and why emoji are refused

A name must start with a letter and may then contain letters, combining marks, spaces,
apostrophes, periods and hyphens — 2 to 60 characters.

**There was no server-side name rule at all.** The register route took any non-empty
string, which made the browser form the only thing enforcing a rule the API is
supposed to own. Emoji, digits and a 200-character name all wrote straight through;
the browser blocked emoji and the API returned `201`. `scripts/error-matrix.mjs`
never caught it because `name` was the one field with no `serverCheck` passed to it —
the parity check silently did not exist for it.

Emoji are refused on purpose, and it is not a style preference. A name is read aloud
at a door, printed on the roster an owner scans, and rendered beside a QR pass:

- **Right-to-left overrides are an identity problem, not a cosmetic one.** A name
  containing U+202E renders with its tail reversed, so the screen says something
  different from what the badge says. A live example of exactly this was written to
  the real roster by a hostile-input probe before the rule existed — the name read
  `admin` on screen.
- **Emoji are unreadable at arm's length**, which is the distance the gate operator is
  working at.
- **Skin tones, ZWJ sequences and flags are multi-code-point**, so a test matching a
  single pictograph misses `👍🏽`, `👨‍👩‍👧` and `🇮🇳`. All of those are matched, along
  with the variation selector and the joiner.

Checked **before** the length rule, because a lone `✅` is one code point — a
length-first order answers *"use at least 2 characters"* to somebody who typed a
party hat on purpose.

And the name must **start with a letter**: allowing a leading combining mark let a
name made only of marks through, matching nothing else and rendering on the roster
as an entry that looks blank. No script begins a word with a combining mark, so
requiring a letter first costs nothing — Devanagari, Tamil, Telugu, Kannada,
Malayalam, Bengali, Han, Arabic, Cyrillic and Greek all still pass, because their
vowel signs come after the consonant. Verified against all of them.

The rule is duplicated in `src/domain/name.ts` and `server/_lib/identifiers.ts`,
because the two bundles are built by different toolchains. `error-matrix.mjs` now
asserts they agree across **93 inputs**, including every emoji and invisible-character
case above. That test is the only reason the duplication is safe.

### SEN validation

Amity University codes are a single letter followed by twelve digits, e.g.
`A866175000012`. That is the shape every example in the UI and docs uses.

Validation is deliberately **permissive** — 4+ alphanumerics containing a digit —
rather than locked to that exact pattern, because the database lookup is the real
gate. A tighter rule would catch typos at the form instead of at the gate, but
would also lock out any attendee whose code differs, which is a far worse failure
in front of a queue.

The check normalises **before** testing, and that ordering is load-bearing.
Scanner payloads are normalised because hardware is inconsistent:
`normaliseSen` unwraps `?sen=`/`?code=`/`?id=` query parameters, finds a bare
identifier token, strips any `.`-delimited ticket signature, and uppercases.
Testing the raw string instead made the browser and the API disagree on thirteen
inputs — lowercase, surrounding whitespace, a `.signature` suffix, and `?code=`
wrappers — the last two being exactly what the gate scanner emits and what a
browser autofill pastes in. A form that rejects something the API would accept is
a failure at the worst possible moment.

### Every request is bounded

`fetch` has no default timeout, so a connection that stalls — venue wifi, mobile
data dropping, a captive portal that accepts the socket and never answers — leaves
the promise pending forever. `scripts/repro-hanging-fetch.mjs` demonstrates this
against a server that never responds.

The failure mode was severe: the session probe only settles in `.then` or
`.catch`, so one that never does leaves the route guard on its boot screen
indefinitely, and an attendee on a bad connection cannot reach the sign-in form
at all.

Every request therefore carries `signal: AbortSignal.timeout(...)`:

| Request        | Budget | Why                                                                 |
| -------------- | ------ | ------------------------------------------------------------------- |
| Session probes | 8s     | Gates first paint, and failing fast to sign-in beats waiting         |
| Everything else| 20s    | Cold serverless start plus bcrypt plus a Postgres round trip        |

A timeout is reported with its own message rather than folded into the generic
network error: they look identical to the user, but a dead connection wants a
retry later while a slow one usually succeeds on a second attempt.

### Error messages

`PortalError` resolves its message as `message ?? PORTAL_ERROR_MESSAGES[code]`.
The API's error class defaulted that message to the code itself, so eight errors
serialised as `{ code: 'unknown_sen', message: 'unknown_sen' }` — and a redundant
message wins over the friendly copy, meaning a gate operator scanning an
unrecognised pass would read the literal string `UNKNOWN_SEN` on screen.

Fixed at both ends: the server omits `message` entirely when it would only repeat
the code, and `PortalError` ignores a message identical to its code. Errors that
carry real wording — `Invalid status.`, `Enter a 10-digit mobile number. You
entered 9.` — still reach the screen unchanged.

### Two kinds of staff account

"Can open the door" and "can run the event" are different permissions, so they are
different accounts.

| | `owner` — full access | `gate` — gate only |
| --- | --- | --- |
| Mark attendance by scan | yes | yes |
| Read the attendance log | yes | yes |
| Read teams | yes | yes |
| The attendee roster | yes | **403** |
| Change an attendee's password | yes | **403** |
| Edit the programme or event phase | yes | **403** |
| Export SEN | yes | not shown |

Whoever is on the door needs to scan a badge and nothing else. They get three tabs
and a scan field.

**The roster is refused, not merely hidden.** `GET /admin/attendees` returns every
attendee's name, phone and SEN in one response — it is the SEN export with an
extra step. A `gate` account gets 403, and the client never issues the request,
so the roster of everyone who has *not* arrived does not pass through a volunteer's
phone on every refresh.

That is why the attendance log carries `attendeeName` on each row, joined in by
the server. It used to resolve names client-side against the roster, which would
have rendered the log as a column of dashes for exactly the person who most needs
to read it. The log's Phone column is gone for the same reason.

Roles are read from the database on every admin request rather than baked into the
session, so a change takes effect immediately. An unrecognised role is treated as
the **narrower** one, in both the server and the client: widening by accident is
unrecoverable, narrowing is merely annoying. `test:roles` asserts this by dropping
the CHECK constraint, writing a third role, and confirming the account is refused.

### There is one gate credential, and it is provisioned from the command line

```bash
node scripts/manage-staff.mjs list
node scripts/manage-staff.mjs add <username> <name> <owner|gate>
node scripts/manage-staff.mjs reset <username>
node scripts/manage-staff.mjs role <username> <owner|gate>
node scripts/manage-staff.mjs disable <username>
node scripts/manage-staff.mjs enable <username>
```

There is exactly one `gate` account, shared by whoever is on the door, and a
couple of `owner` accounts. That is four rows that change perhaps twice before the
event.

**The portal has no Staff panel, and deliberately so.** One existed — create, role
change, password reset, deactivation — and it was removed. Managing four accounts is
not worth a settings screen, and every route it needed was attack surface reachable
by anything holding an owner session. Provisioning from a machine with database
access is the better shape: it is a rare, deliberate act, and it cannot be
triggered by a stolen cookie.

The cost is honest and worth stating: **if the gate credential leaks, rotating it is
a command on a machine with database access, not a button.** `reset` prints the new
password once and signs out every existing session.

`add` and `reset` generate the password rather than accepting one, so a credential
cannot be chosen from a weak word or leaked through a shell history. Two invariants
are enforced, because this is now the only place they can be:

- the last active `owner` cannot be disabled or demoted
- any change to an account deletes its live sessions, so a demotion bites on the
  next request rather than at cookie expiry

Every change is written to `staff_changes`.

### The export is a speed bump, not a wall

Worth being straight about. A `gate` account can read the attendance log, so it can
see every marked SEN on screen and could write them down. Hiding the export button
does not prevent that, and no client-side control could — the data is already in the
browser.

The real boundary is that `/admin/attendees` is refused, so a volunteer never holds
the full roster. Letting them see the log while forbidding the export is a
convenience and a speed bump, not a security boundary. If the log has to be closed
too, that is a deliberate decision and one line of change.

### Who may register: open, restricted, closed

`events.registration_mode` is one of three values, and every registration goes
through it before any uniqueness check.

| Mode | Who may register |
| --- | --- |
| `open` | anyone — the default, and where the portal lives for the weeks of sign-ups |
| `restricted` | only SENs on the uploaded guest list |
| `closed` | nobody |

**It replaced a boolean, because a boolean could only narrow.** `roster_required`
answered "is the list being enforced?" and there was no way at all to say *shut the
door entirely*. That is the state a portal is in once capacity is reached, and on
the morning of the event it is the one an organiser most needs and could not ask
for. `restricted` and `closed` are now different codes with different copy: telling
a student "you are not on the guest list" when the truth is that nobody may
register sends them off to email an organiser about the wrong thing, for a list that
is irrelevant to them.

The migration backfills rather than defaults: `roster_required = true` became
`restricted`, so switching this in could not silently reopen a list somebody had
already enforced. A `CHECK` constraint holds the set of three, because a
hand-edited fourth value must not be able to leave a portal where nobody can
register and nothing says why.

**The mode is public.** `GET /event` carries it, so the registration form can say
"registration is closed" on arrival rather than after four fields of typing. It is
printed on the door; it is not a secret. When it *is* closed the form is replaced
rather than disabled — a disabled form reads as "temporarily broken, try again",
which is the opposite of what is true. `restricted` keeps the form, because the
visitor may well be on the list, and hiding it would lock out listed students too.

**The switch is independent of the list, in both directions.** `restricted` is
disabled until a list has been uploaded, since it would otherwise present an empty
door with nothing explaining why. And **clearing the list does not change the mode** —
they used to be one action, and tidying up a spreadsheet that turned out to contain
a duplicate would have shut the door to every remaining student as a side effect. The
panel says so before the click, and offers one click back rather than doing it
silently. The consequence is real and asserted: a `restricted` registration with an
empty list refuses everybody, including SENs that were on it.

### The guest list

An owner uploads a spreadsheet of names and SENs from **People → Guest List**.

**Keyed by SEN alone, and the uploaded name is never compared to anything.** A name
is what a volunteer mishears, what a student types with one letter wrong, and what
two people share. Matching on it would lock out real students over spelling — and
the name on a college list is exactly the field that gets transcribed wrong. The
SEN is the one identifier both sides agree on, and it is already the gate's.

**Replaced wholesale, never merged.** An upload is a statement about who may
register *now*, and someone who has left must stop being able to. Merging would make
a list impossible to shrink, which is the correction an organiser most often needs.

**All-or-nothing.** Every row is validated *before* anything is written, and the
delete plus the insert run in one transaction. A partially-applied list would lock
out whichever students did not land, and the symptom they would see is "you are not
on the list" — which points at the list rather than at the upload that broke it.

**The list is never returned whole.** `GET /admin/roster` gives a count and a sample
of eight. The full thing is every student's name and SEN in one response, which is
exactly what a `gate` account must never receive; the owner has the file they
uploaded, so nothing is lost. The route is owner-only.

**Already-registered accounts are untouched.** The check is on registration only, so
enforcing a list never invalidates somebody who signed up before it was uploaded.

### Adding somebody by hand

`POST /admin/attendees` creates one account without the registration form. It is the
only route that can bypass the guest list, which is the point: an organiser at a
desk with a walk-in who is not on the list, or with registration closed because the
room is full, has to be able to let that one person in. Refusing would leave them no
way to do the one thing they are there to do.

**Owner-only, audited, and it issues no session.** Every other privileged act in this
product writes to `password_changes` or `staff_changes`, and so does this — an
account created out of band, with a password the organiser chose, is the single most
sensitive action available and it leaves a trail. The person is not at that
computer, so issuing a cookie would silently sign them in on a device they may never
see again, and signed in without typing the password that was just read out to them,
which defeats the point of setting one.

**Validated by the same functions the form uses** — name, phone, SEN shape, password
strength, and uniqueness on both phone and SEN. A weaker path here would be a way
around every rule added since, and an organiser adding somebody twice should get a
`phone_taken` or `sen_taken` rather than quietly doubling a name on the roster.

**The password is chosen by the operator and read aloud.** Generating one and showing
it once would be friendlier, and would also put a credential on a screen anyone
walking past can see — which is why the desk password flow reads it out too.

#### Reading the spreadsheet, without a spreadsheet library

`.csv` and real `.xlsx`, both parsed in the browser, **with no dependency added**.

The obvious choice is SheetJS. The version npm serves is 0.18.5 — frozen in 2022,
with SheetJS themselves moved off npm, and two unpatched advisories on it: a
prototype-pollution bug (CVE-2023-30533) and a ReDoS (CVE-2024-22363). This
feature's entire job is to parse a file somebody hands it, which is precisely the
input those two are about. `exceljs` has no such history and is 22MB.

An `.xlsx` is a ZIP of XML, and every browser since 2023 ships
`DecompressionStream`, which inflates a raw deflate stream natively. That is the
only hard part, and `src/lib/roster/parse.ts` is about a hundred lines of ZIP
reading on top of it. The ZIP **central directory** is read rather than the local
headers, because only the central directory records real sizes — a file from a
streaming writer leaves zeros in the local header until a data descriptor follows.

The file is parsed in the browser and only the rows are POSTed, so the server never
handles a spreadsheet: a format bug cannot take registration down, and the preview
is of exactly the rows that will be stored. The server then re-validates every row
with the same functions registration uses, so a client that skipped the checks gains
nothing.

Details that each cost a row of somebody's real data:

- **Column order is not assumed.** Headers are matched by name — `sen`, `student id`,
  `roll no`, `reg no`, `usn` — because no two spreadsheets agree on order.
- **A quote only opens a field when it is the field's first character.** A name like
  `Grace O"Hopper`, written unquoted (which Excel allows), used to flip the parser
  into quoted mode mid-word and swallow the comma after it. The SEN disappeared and
  the row was reported as *having no SEN* — a parser bug presenting as bad data.
- **The preview validates the SEN shape.** It says "N students ready", which is a
  promise. Checking only for a non-empty cell let a shifted column claim every row
  was fine and then the server refused the whole upload.
- **A per-run preview, never auto-uploaded.** The panel shows the first rows and the
  count and waits for a button — there is no confirmation dialog on top, because a
  second "are you sure" trains people to click through dialogs, which is worse here
  rather than better when the action locks students out.
- **`.xls` is refused by name**, with "save it as .xlsx", rather than failing later
  with a ZIP error nobody can interpret.

### The portal is live

Nothing in this portal requires a reload, on either side. Closing registration,
opening or closing a day, pinning the day override, changing the phase, moving a
session in the agenda, and marking somebody present at the gate all reach every other
open device within five seconds.

Two devices is the normal arrangement on the day — an owner with the laptop managing
the switches, a volunteer with a phone at the door — and without this the phone has no
idea any of it happened until somebody reloads it in front of a queue.

**One event poll, and it never stops.** `GET /event` already carries everything the
portal shows about the event, so a single request per tick keeps the phase, the day,
the locks, the registration mode and the agenda current. It runs for anonymous
visitors too, not only signed-in ones: the register form is where a stale value is
most expensive, since somebody may be part-way through typing against a portal that
has already been shut.

**It applies nothing when nothing changed.** `eventSignature` compares a fixed list of
the fields the UI reads. `JSON.stringify(event)` would compare key insertion order as
well as content, so any response assembled in a different order would look permanently
different and the dashboard would re-render every five seconds for as long as it was
open. The named list is also the answer to "what does this poll actually keep fresh?",
which is not otherwise a question the code can answer.

**It skips hidden tabs and re-reads on return.** An attendee holding their pass has
this tab in the background, and an idle phone should not be spending a database on it.
The `visibilitychange` listener covers the case where the tab has been asleep an hour:
the first thing that happens on becoming visible is a fetch, so nothing is lost by
skipping the ticks.

**A stale response cannot undo a write.** Every mutation bumps a counter before it
sends its request, and a poll captures that counter before its own requests go out. If
a write landed in between, the poll's answer describes the past and is discarded.
Without this, closing a day flickers back to open for up to a tick.

**The roster is deliberately not polled.** It changes when somebody registers, which
is not a door-side event, and it is the one response carrying every attendee's name,
phone and SEN. Refetching it every five seconds on every open owner device would put
the whole roll through the network for no benefit. Adding somebody by hand refreshes
it, and the Refresh button is there.

### Day state has exactly one home

`EventInfo` is the only place `activeDay`, `totalDays`, `dayOverridden` and
`lockedDays` live.

`/attendee/attendance` used to return them alongside its records. It no longer does,
and that is a fix rather than a simplification. The poll for attendance **stops** once
this attendee is marked for the day being scanned into — correctly, because a record is
append-only and immutable, so there is genuinely nothing further for it to learn. But
it stopped the duplicated day state too. An organiser reopened Day 2, and every
attendee who had already been marked on Day 1 went on reading "Closed" on Day 2 until
they reloaded by hand.

Two copies of one fact is two things that can disagree, and they did. The records poll
now carries records; the day state poll never stops.

### Two things a request-level test cannot see

Both of these were found by opening a page and reading it.

**Display type that overflows its own box.** The headings were a fixed `text-6xl`. At
60px, "REGISTER" is 237px of type, and a 270px phone has 222px of content box after
the padding — so the heading overflowed and the page scrolled sideways. The size is now
`clamp(1.75rem, 9vw, 3.75rem)`: a breakpoint would jump the size at a width nobody can
feel, and `clamp` scales with the viewport so the heading is as large as the screen
allows and stops at the old 60px from `lg`.

It survived two sweeps because the detector was wrong, not the layout being subtle. The
check was `getBoundingClientRect().right` against the viewport — and the heading's
**box** fitted. Only its text did not. Anything that overflows inside a box that itself
fits is invisible to a right-edge check; `scrollWidth > clientWidth` is what finds it.

**A hover state that showed a label twice.** `SlideNavLink` renders the label twice —
a resting copy and an accent-coloured copy that slides over it on hover — and the
effect depends on the two sharing one box. The registration page styled that anchor as
a full-width button with `inline-flex justify-center`, which overrides the anchor's
display. `justify-center` then centred the in-flow copy at `left: 254px` while the
absolutely-positioned one stayed pinned to the left edge, so hovering produced the
label twice at once: accent-coloured on the left, paper-coloured in the middle. Both
positions were real; neither was right.

Fixed at the root rather than at the call site: the two copies now live inside an inner
block that no caller can reach with a display utility. The button that triggered it is
also a plain `Link` now, because a sliding text swap is not what a primary button wants.

### A refresh must not log anybody out

A failed session probe is **unknown**, not anonymous.

The probe has an 8-second timeout, because a stalled connection would otherwise leave
the boot screen up for ever — a deliberate and correct trade. But routing its *failure*
to `anonymous` meant one slow request on venue wifi turned a perfectly valid cookie
into a redirect to `/login`. To the person experiencing it, that is "the portal logged
me out".

It was most reliable on a manual refresh, which is the worst possible moment: a refresh
is a cold serverless start on a phone that has just come off a lock screen, so it is
the single most likely request in the session to be slow.

So the probe is retried once, and only a second failure concludes anything. One retry
and not a backoff loop, because each attempt can burn the full probe budget — three
attempts is up to 24 seconds of boot screen plus the gaps, which is worse than showing
the sign-in form. If the retry *does* find a session, the status flips to `active` and
the route guard sends the attendee to the dashboard on its own.

Cookie persistence was never the problem and was checked: `Max-Age` in seconds,
`Expires` alongside it, `HttpOnly`, `SameSite=Lax`, and 30 days when "remember me" is
on.

**A self-service password change keeps the session in use.** The admin password route
deletes every session for the attendee, which is right there — the administrator is not
the person at the other end. Doing the same to a self-service change signs the attendee
out of the tab they are standing in, at the exact moment they have just proved they
know their password, and it is indistinguishable from the portal signing people out by
itself. `revokeOtherSessions` excludes the caller's own token.

### The password is the portal's

Registration does not ask for a password. The portal generates one, shows it, and
offers the choice of keeping it or typing their own **on the same screen**.

The old form asked for a password and then made them type it twice, on a phone, at a
desk, in a queue. A single mistyped character locked them out of their own pass, with
no self-service recovery — the recovery path is an organiser at a desk, which means
queueing again.

**Three screens, not five.** It used to be: details, then the generated password, then
a read-back, then a question about changing it, then the change form. Four screens to
reach a pass, for a decision that is really one question with two answers.

The read-back went first, and not because the check was wrong — requiring the two boxes
to match, then comparing against the stored hash, was a real defence against somebody
misreading the password and typing the same wrong thing twice. It went because it
catches a lot of nothing. Nobody mistypes a password they have just been shown and have
not written down, and the cost was four screens between a student and their pass, at a
desk, in a queue. Losing the password is recoverable; the desk sets a new one.

What is left is a single screen: the password, large and monospaced, with **Use this
password** and **Type my own instead** beneath it. Somebody who wants their own types it
right there. Somebody indifferent is one tap from done.

**The generated shape is dictated by being read aloud** over a noisy room:

| Rule | Why |
| --- | --- |
| No `0`/`O`, `1`/`l`/`I` | indistinguishable in most sans-serif faces, and the commonest way a read-back goes wrong |
| No punctuation beyond the group dash | every symbol is a thing to name out loud |
| Lower case only | nothing to distinguish, so nothing to get wrong |
| Digits `2`–`9` | no look-alikes |
| Three groups of three | short enough to read one character at a time, and to hold in your head while typing |

31 characters per position, so 31^3 = 2.6e13 — about 44 bits. Ample for a credential
whose real lifetime is one weekend, and not worth a longer string that is harder to
read correctly, which is the failure mode that actually costs somebody their place.
`randomInt` from `node:crypto`, not `Math.random`, whose internal state can be recovered
from a handful of outputs and would make every password it ever issued predictable.

**It is shown once, and only once.** The password comes back in the registration
response and only its bcrypt hash is ever stored. There is deliberately no route that
can return it again — a "resend my password" endpoint would make the portal a
credential oracle for anyone who knows a name and a phone number. An attendee who loses
it asks at the desk.

Typing their own still requires the generated one as `currentPassword`, even though it
is on screen. That is not a formality: the check establishes that the session belongs
to whoever just registered, and an attacker holding a stolen session could skip past it.

`password` is still accepted on the register endpoint, and validated identically when
present. That is not a hole — a supplied password must still pass `passwordProblem`
exactly as a generated one does — and it keeps the API usable by the test suites, which
have to register a known password in order to log back in with it. The browser form
never sends the field, and the response does not echo it as though it had been generated.

### Reading the guest list back

`GET /admin/roster` returns a count and a sample of eight. That is the right default —
the panel header wants to know whether anything landed, not to hold five hundred
students in memory to say "yes, 500" — but it left an organiser unable to do the one
thing they uploaded a list to do, which is look at it.

`GET /admin/roster/rows` is a separate owner-only route for that, fetched only when
the panel's **Check all N names** control is opened. The upload preview shows what the
*parser* made of the file; this shows what the *database* ended up holding, which is
the question that matters before enforcing — the row where a column shifted, the SEN
that lost a digit, the name that became the SEN. A count cannot tell you any of that.

Owner-only is not incidental: the full list is every student's name and SEN in one
response, which is precisely what a `gate` account must never receive.
`requireOwner()` runs before the query, so the rows are not even read for an account
that may not have them.

Capped at 5,000 rows, and the cap is **reported** rather than applied silently.
Truncating a check would produce "I looked at every name and they are all correct" for
whatever rows happened to be returned, which is worse than not offering the check at
all.

The list is a bounded-height scroll with a filter above it, matching on name **or**
SEN. Scrolling 500 rows to spot one mistake is how the mistake survives; and the two
failures an organiser is hunting for are different, so matching on name alone would
make a mangled SEN invisible.

### Getting back in: how an attendee is identified

Login is **phone number + password**, with the **name as a second factor**. The name
is there so that knowing somebody's number is not enough to walk in with their pass,
and every failure returns one identical message so the endpoint cannot be used to
discover which numbers are registered.

The name is compared on `nameKey` — lowercased, whitespace collapsed — rather than
exactly. **This was a live lockout.** Registration accepts a name with internal
double spacing (`Mary  Ann` is valid, and is in the error matrix), but the login used
to compare the name character for character, so the same person typing `Mary Ann`
— the most natural way to type it — was refused. There is no self-service recovery,
so that is an emailed plea to the organiser, days before an event, for a pass they
had just been issued.

What still fails, and must: a different name, a different spelling, and an added
middle initial. Collapsing case and spacing does not weaken the second factor, it
stops it punishing a typing habit. Asserted in `test:api` on all three sides of
that line.

### Password recovery is by email

There is no self-service password reset, and its absence is deliberate.

The portal used to have one. It took a phone number and a new password with **no
verification of any kind** — no OTP, no email, no security question — so knowing
someone's number was enough to take over their account and present their pass at
the gate. Rate limiting (5 per number per hour, 20 per caller IP) was the only
control, and the endpoint was under active probing in production, with the per-IP
limiter holding at exactly its configured ceiling.

That was the most serious weakness the portal had. It was fixed by deleting the
endpoint, not by tightening it.

Recovery now works like this:

1. The attendee emails the organiser from the **Password help** panel on the login
   page. The address is a real `mailto:` with the subject line pre-filled, so the
   request arrives identifiable without them composing anything.
2. An owner opens the **Desk** tab, searches by name, SEN or phone, and sets a new
   password.
3. Every existing session belonging to that attendee is revoked.

The help lives in `src/components/PasswordHelp.tsx` as its own component rather
than a paragraph inside the form. Two reasons, both from what it has to do: a
locked-out path should not read as part of the sign-up flow, and a `mailto:` buried
in a run of label text is easy to miss and easy to make unclickable.

**One address, in one file.** `src/domain/contact.ts` holds it, and **five** places
read it: the footer contact link, the password help, the guest-list refusal, the
registration-closed refusal, and the note on an attendance day that has been closed.

Five consumers of one value is not decoration — it is where the drift comes from. The
file's own comment named *two* components and said the address "lives here rather than
being declared in either component", which was already untrue: three pieces of copy in
`types.ts` and `AttendancePanel.tsx` each carried their own literal. Changing the
address meant finding all four by hand, and the test suite did not help, because two of
its assertions pinned the literal address. Changing it failed tests that were never
about the contact address and invited the wrong fix — pasting the new address into
whatever broke.

It is one literal now, and `test:live` asserts that exactly: any email address anywhere
in `src/` is a failure unless it is the declaration itself. The suite deliberately does
not pin *which* address, because which inbox is a decision rather than a spec, while
"there is only one of them" is the invariant worth protecting. The two tests that used
to name the old address now assert the shape — that the copy reads the constant, and
that the constant is a real address.

| Property | Why |
| --- | --- |
| Requires an authenticated admin session | Nothing to probe — an attacker cannot reach the route |
| Identified by **SEN**, not phone or name | The SEN is on the badge and is already the gate's identifier; names collide, phone numbers get misheard |
| Server re-applies the registration password rules | An owner cannot set a weaker password than a self-registering attendee could choose |
| SEN matched case-insensitively after normalising | An organiser reading a badge aloud types it however they heard it |
| Revokes all of that attendee's sessions | A password change that leaves old sessions alive has not locked anyone out |
| The attendee portal has no such link | Recovery is a conversation with a person, and the login page says so |
| Every change is recorded | A privileged credential change should be attributable |

The audit trail lives in `password_changes` (append-only, like `attendance`) and
records which admin authorised a change, for whom, and when. It is deliberately
not exposed over the API — the same reason the test suite reads it straight from
the database:

```sql
select a.sen, a.name, ad.display_name as changed_by, pc.at
  from password_changes pc
  join attendees a on a.id = pc.attendee_id
  join admins ad on ad.id = pc.admin_id
 order by pc.at desc;
```

This trades a self-service flow for a queue at the desk. For a two-day event
where an attendee is standing in front of the person changing their password,
that is the right trade: the identity check is a face and a badge, which is
stronger than an SMS OTP in the sense that actually matters here.

The `password_reset_attempts` table is left in place but is no longer written to.
Its rows are an accurate record of the probing the old endpoint received.

**Staff credentials have no recovery route at all.** An admin password is changed
in the Neon console or the Vercel environment and redeployed — out of band, not
over the public API.

### Route guard

`Guard` lets through **only** the named status and redirects everything else,
which is counter-intuitive: `when="active"` on `/dashboard` would bounce
anonymous visitors to `/login`, which is fine, but the same value on `/` would
bounce them to `/dashboard`, whose own guard bounces them on to `/login`, and the
landing page would never render at all. Hence `/login` and `/register` are both
`when="anonymous"`.

`/forgot-password` no longer exists as a route and falls through to the
catch-all, landing on `/login` — where the "ask the desk" instruction is. A
deliberate dead end rather than a 404: anyone who reaches it is locked out, and
a locked-out person needs an instruction, not an error.

`/` is `when="any"`, so the hero renders for a signed-in visitor too — the shared
link is the thing pasted into a group chat and it should show what it promises.
The hero swaps its own actions once it knows there is a session, so reaching the
pass stays one tap:

| Visitor | Actions                    | Caption                          |
| ------- | -------------------------- | -------------------------------- |
| Anonymous | `REGISTER` · `LOG IN`     | `ALREADY REGISTERED? LOG IN HERE.` |
| Signed in | `YOUR PASS`              | `SIGNED IN AS <name>.`           |

All routes render the boot screen while `status === 'initialising'`, so no page
shows one version and then swaps it.

---

## Front end

### The landing page

The public front door answers three things on one screen: what this is, when and
where, and how to get a pass. Event details are read from the API rather than
written into the component, so renaming the event or moving the dates in
`db/seed.sql` updates the hero and the facts row at once.

**Both entry points clear a phone.** A returning attendee and a first-timer land
on the same screen with opposite needs, and "Register" is the red accent, so it
dominates. Three things prevent the wrong one being chosen:

- The action row is side-by-side from the smallest screen up. Stacked, "Log in"
  landed at 646–710px — entirely below the fold of a 667px phone, with Register
  above it.
- One line names who Log in is for. Kept to a single line, because the two-line
  version ended at 700px and the note was itself invisible on the smallest phone
  it was written for.
- Vertical rhythm steps down on phones. Measured at 375px, where the facts grid
  is two rows rather than the single row a tablet gets:

  | Spacing         | Buttons land at | On a 667px phone    |
  | --------------- | --------------- | ------------------- |
  | `py-16`/`mt-10` | 640–704px       | Log in 37px below   |
  | `py-8`/`mt-6`   | 584–648px       | Both visible, 19px clear |

  `sm:` restores the original rhythm and `lg` keeps its larger padding, so the
  desktop layout is unchanged.

**The programme is not on this page.** It lives on the attendee dashboard
(`EventStatusPanel`), still grouped by day. A public page listing every session
competes with the one decision it exists to make; attendees get the programme once
they are in.

The facts are labelled `Date` / `Venue` / `Hosted by` rather than `When` / `Where`
/ `Host`, which read like form fields rather than an institutional event page.

#### The footer

Host block hard left, one Connect list beside it, then a full-width rule and the
legal line. Two columns rather than four — there is not enough here for three
columns of links, and empty columns read as broken.

Three details that are each a small way this can go wrong:

- **Contact is a `mailto:`** and deliberately carries no `target="_blank"`.
  Opening a mail client in a new tab leaves an empty one behind on some browsers.
- **Every external link carries `rel="noreferrer noopener"`.** Without it the
  destination receives `window.opener` and can navigate this tab — a real risk on
  a page holding a session cookie, and invisible in review.
- **Roles sit beside names, not inside link text**, so the accessible name stays
  the person's name.

### The verb is "log", never "sign"

Every authentication verb in the product reads **log in** / **log out**. Not "sign
in", not "signed in", not "sign out" — and not "signed out" in prose either. A
mixed pair ("Log in" on one screen, "Sign out" on the next) reads as a bug even
when nobody can point at what is wrong with it.

This was broken in six places at once and nothing failed, which is why it is now a
test rather than a habit. `test:landing` walks every `.ts`/`.tsx` file under `src/`,
strips comments, and fails on any surviving `sign in` / `sign out` / `sign on`. The
comment-stripping matters: the comments that *explain* this rule necessarily quote
the banned phrases, so a naive match would be impossible to satisfy.

Three related labels came out of the same sweep, because the same reasoning applies
to each:

| Instead of      | It says                        | Why                                                     |
| --------------- | ------------------------------ | ------------------------------------------------------- |
| "Signed in"     | "Operating as" (admin)        | Names whose session this is, not a session state         |
| "Signed in"     | "Registered as" (attendee)    | The fact that is actually true, and that is not a session |
| "Signed in as"  | "Registered as"                | Same, on the landing caption                             |

### The admin portal is a phone screen first

The control room is used on a phone, held one-handed, at a door, with somebody
waiting. Three consequences run through its layout, and all three came from measuring
the built page at 320/ 360 / 414px rather than from reasoning about it.

**Tabs are grouped by task, not by data type.** Everything about *people* — the
registration switch, adding somebody by hand, the guest list, and the roster of who
has registered — is under **People**. Everything that configures the *event* is under
**Event**. Scan is untouched and stays the default, because it is the screen somebody
opens two hundred times. Before this, the roster sat under "Desk" and the guest list
under "Programme", and a manual add would have been a third place to look.

**Two columns on a phone, five across from `sm` up.** `flex-wrap` was the original and
it wrapped raggedly — three on one row, two on the next, reading across like a broken
grid. The odd tab out spans both columns, because a two-column grid with an odd count
otherwise leaves one cell of the row's ink background showing as a solid black
rectangle beside the last tab, which reads as a rendering fault rather than as a gap.
The count changes with the role, so this has to hold at three tabs as well as five.

**The display heading is desktop-only.** "CONTROL ROOM" is a hundred and forty pixels
of branded type on a laptop, and on a phone it pushed the scanner — the one thing the
portal is opened to use — most of the way down the screen. Mobile gets one quiet line
and the vertical space goes to the controls.

Three layout bugs this found, all invisible on a desktop screenshot:

- **`flex-wrap` alone leaves ink gaps.** Making the phase buttons wrap fixed a 360px
  overflow and introduced a black block beside "COMPLETED", because the segmented
  control paints its 1px separators by showing the row's ink background through. The
  fix is `flex-wrap` on the row *and* `flex-[1_0_auto]` on every button — grow, never
  shrink, sized to content — so a short row's buttons grow until the gap is gone.
- **A grid item will not shrink below its content.** `min-width: auto` on a grid item
  meant the guest-list panel forced its column to 401px inside a 306px track, and the
  whole People tab scrolled sideways on a phone. `w-full` does not help: the culprit is
  a file input's intrinsic width, which no width rule overrides.
- **A control that is irrelevant to a screen should not be on it.** The day picker,
  the SEN export and the count sat in a bar at the foot of every tab, which put a day
  selector and an export button on the scanner. Both consumers of the day are now on
  the Attendance tab, next to the log and the export they act on, so they cannot go
  out of step — and the screen somebody uses most carries nothing it does not need.

### Design system

Swiss International. All tokens live in one `@theme` block in
`src/styles/index.css`; no component contains a raw hex value.

| Token                       | Value     | Role                     |
| --------------------------- | --------- | ------------------------ |
| `--color-swiss-paper`       | `#FFFFFF` | Neutral canvas           |
| `--color-swiss-ink`         | `#000000` | Text is absolute         |
| `--color-swiss-muted`       | `#F2F2F2` | Secondary surfaces       |
| `--color-swiss-accent`      | `#FF3000` | The only signal colour   |
| `--color-swiss-accent-text` | `#D62500` | Text-safe accent         |
| `--color-swiss-accent-on-dark` | `#FF5C36` | Accent on black       |

**Why two reds.** `#FF3000` measures 3.70:1 on white — enough for graphic
elements, short of AA's 4.5:1 for text. So `swiss-accent` is for fills, borders
and marks, and `swiss-accent-text` for any surface or glyph carrying text.

Structure is visible: 2px ink rules, radius `0px` everywhere, uppercase
micro-labels at wide tracking, and texture in place of shadow.

**The mark.** `public/fetch-ai.svg` is a placeholder, not the official artwork.
Overwrite that one file — any square-ish SVG works, transparent or white, since it
is composited with `mix-blend-mode: multiply`. The monochrome state is produced
with a CSS filter on the same asset, so the two can never drift apart. A missing
file falls back to a text wordmark rather than a broken-image icon.

**The glitch cycle** runs 2s on the mark only — the one documented exception to
the no-decorative-motion rule, present in both portals. It uses many fine keyframe
stops rather than two, which is what reads as a datamosh instead of a jump cut.
Under `prefers-reduced-motion` it is suppressed and a single state is held, since
it is decorative and repeats indefinitely (WCAG 2.3.3).

### Motion

One layer in `src/styles/index.css`, consumed as utility classes. Every animation
does one of three jobs — **feedback**, **orientation** or **latency** — and one
that does none of them does not belong.

| Surface                        | Motion                                        |
| ------------------------------ | --------------------------------------------- |
| Route change                   | 260ms cross-fade, keyed on pathname            |
| Hero                           | One-shot sequence (see the entrance table)     |
| Dashboard programme rows       | Staggered rise, 45ms apart                     |
| **Attendance → marked**        | Scale-in — changes without the attendee acting |
| QR pass appearing              | Scale-in                                       |
| Validation messages            | Fade in, inside reserved height                |
| Buttons                        | 1px press settle on transform                  |
| Loading skeletons              | Shimmer — the one permitted loop               |
| Admin tabs, attendance, desk, teams | Cross-fade and stagger                    |
| **Admin scan panel**           | **None, deliberately**                         |

Four rules, each with a failure behind it:

- **Transform and opacity only.** Animating `width`, `height`, `top` or `margin`
  forces layout every frame, which drops frames on the mid-range phone an
  attendee holds on venue wifi.
- **Short.** 180/260/360ms. Past ~400ms a transition stops reading as responsive
  and starts reading as lag.
- **One-shot.** Nothing loops except the loading skeleton, which stops when
  content replaces it. A loop is a permanent battery tax on someone holding a page
  open.
- **No motion on the gate.** The scan panel is what a volunteer uses at a busy
  door, usually on a phone, with the camera preview and an on-screen keyboard in
  play. Tabs, attendance, desk and teams animate; the scan panel does not.

**Stagger is capped** at `STAGGER_CAP = 8` in `src/lib/motion.ts`. Uncapped,
45ms × 500 attendance rows is a 22-second wait, and every row past the eighth is
noise. The animation exists to show the eye where a list *begins*, not to make
anyone wait for it to end.

**Reduced motion needs more than the blanket rule.** Collapsing
`animation-duration` handles most of it, but `animation-delay` is a separate
property and survives untouched — so without an explicit override a reduced-motion
visitor still sits through the full accumulated stagger before anything appears,
which is the opposite of what they asked for. Stagger delays and the skeleton loop
are zeroed explicitly.

### Accessibility

- Focus is a 2px accent outline with offset; inputs use an accent border, no glow.
- Errors use `role="alert"` with `aria-live`, linked by `aria-describedby`.
- A failed submit marks every field touched and focuses the first invalid one.
- Touch targets: inputs 56px, buttons 64px, checkbox row 44px.
- Reduced motion honoured throughout, including the logo glitch.
- A skip link is first in the tab order on every auth screen.
- Colour is never the only signal; every status carries text.
- The camera scanner degrades to typed entry when permission is denied or the
  browser has no camera API, so the gate is never blocked by a browser quirk.

---

## Testing

532 assertions across 16 suites, plus a 291-case error matrix.

| Suite           | Assertions  | Database | Covers                                                    |
| --------------- | ----------- | -------- | --------------------------------------------------------- |
| `test:api`      | 63          | yes      | Real cookies, bcrypt, writes, scan conflicts, auth guards, and that case/whitespace never lock an attendee out of their own pass |
| `test:gate`     | 28          | yes      | Signature verification, the `printed` fallback, admin-mediated recovery and its audit trail |
| `test:copy`     | 26          | yes      | Every error code renders as human copy; specific wording survives |
| `test:desk`     | 57          | no       | Roster search normalisation; the panel's structure; the password-help email; no self-service reset |
| `test:roles`    | 34          | yes      | Every owner-only route refused to `gate`; an unrecognised role fails closed; the CLI's guards |
| `test:day`      | 21          | no       | Calendar resolution in IST, pinned to fixed dates including the midnight rollover |
| `test:perday`   | 29          | yes      | One record per attendee per day; both days recorded; the lock on future days; refuses to adopt a pre-existing day pin |
| `test:lock`     | 23          | yes      | Closing a day refuses new marks; existing records stay readable; a locked day one does not lock day two; `gate` cannot open a lock |
| `test:guestlist`| 62          | yes      | Open / restricted / closed, the switch and the list as separate decisions; `closed` stops listed SENs too; a refused upload changes nothing at all; clearing the list does not reopen registration; manual add, including uniqueness and the same validation as the form; `gate` can do none of it |
| `test:registration` | 36     | yes      | The generated password's shape, the read-back endpoint caught by the server when **both** boxes are wrong, a self-service change that keeps the session alive, and the owner-only row reader |
| `test:live`      | 50          | no       | The live-update wiring itself, plus the UI invariants a request test cannot see: both polls, the change check, the write-ordering guard, the retrying probe, day state having exactly one home, one contact address declared exactly once, fluid display type, the slide link surviving a display override, and the footer reaching every attendee page |
| `test:parse`    | 44          | no       | CSV and a real generated `.xlsx`, column matching by header, quoting edge cases, and every malformed input refused by name |
| `test:export`   | 8           | no       | The exact CSV bytes: one SEN per row, no header, other days excluded, BOM, CRLF |
| `test:errors`   | 291 inputs  | no       | Every field rule, plus client/server agreement on accept, normalisation and rendering. 93 name cases including emoji, skin tones, ZWJ sequences and invisible formatting |
| `test:landing`  | 95          | no       | Entry points clear a phone; footer destinations; links open safely; the auth verb is "log", never "sign", across every file in `src/`; the error boundary is wired and leaks nothing; both out-of-portal refusals name a contact and stay distinct |
| `test:motion`   | 22          | no       | No layout animation; durations short; scan panel still; stagger capped |
| `test:scan`     | 20          | no       | Confirmation rendered, not red, not timed out; camera scans do not steal focus |
| `test:phone`    | 24          | no       | Phone normalisation, problem messages, client/server parity |
| `test:dates`    | 18          | no       | Two-day range and per-day headings, timezone-safe          |

### Test fixtures must not outlive the run

The suites marked "Database" above register real attendees against the live
database, because the registration endpoint is what is under test. An attendee row
is indistinguishable from a real one: it appears on the owner's roster, in the
attendance log, and in the SEN export. Five such fixtures had accumulated before
this was noticed, four carrying attendance marks — so the live log showed ten people
on day one when five had actually arrived. The export is the artefact the event
hands to whoever issues certificates, so junk in it is junk handed on.

`scripts/_fixtures.mjs` is therefore the single convention:

- every fixture SEN is built with `testSen(tag)` and starts with **`ZTEST`** — not an
  Amity letter, digits all zeroes, so a fixture cannot be mistaken for a
  registration in a screenshot or a log line;
- every live suite calls `purgeTestAttendees` when it finishes, **on success and on
  a crash**, because a suite that throws halfway is the one that most needs to clean
  up;
- the sweep is scoped **by prefix, not by the current run's SEN**, so a crashed or
  interrupted run is still mopped up by the next one. Deleting only what this run
  created is what let stale fixtures accumulate in the first place.

`test:perday` had fixed this for itself with a private `PDAY%` rule; doing it once
per suite is how the same leak came back three times. The legacy prefix is still
swept, so stragglers from older runs disappear on the next run.

### A test must never adopt state it did not create

`test:perday` and `test:lock` move the live event's day and close its days. Both
capture whatever they find and restore it — which is correct, and is exactly how a
**stale pin survives forever**.

Found on 2026-10-07, eight days before the event: `day_override` set to `2`. The
portal believed it was Day 2 of 2, so **every scan was filing under day two**. A run
had been interrupted between "set" and "restore"; the next run read the leftover
value, decided it was the original, and put it back. No assertion ever saw it,
because every assertion *inside* the suite passed.

Three things changed:

- **A pre-existing pin is now a failure, not a starting condition.** Asserted loudly,
  naming the value and the remedy.
- **It is reset, not restored.** A stale pin changes which day real attendance lands
  in; that is worse than a red test.
- **The day is restored first, and unconditionally.** The attendee purge used to run
  first and unguarded, so a throw there skipped the restore entirely. The day is the
  more damaging of the two by far — a stale attendee is one row on a roster, a stale
  pin misfiles a whole day — so it goes first and it goes regardless. A failure
  there prints the exact SQL to fix it.

### The suites must not assume it is day one

`test:api` asserted a scan records `day === 1`, and `test:copy` asserted a duplicate
scan carries no message. Both are true only while the calendar says day one. On the
morning of day two they failed for reasons that had nothing to do with the code —
three suites' worth of red that looks like a regression and is actually a stale
expectation.

Both now read the event's own `activeDay`. Verified by pinning the live event to day
2 and re-running: everything green. And `test:copy`'s duplicate-scan assertion now
tests the real invariant — *never the machine code repeated back* — which holds on
every day, rather than the day-one shape.

There is also a one-off administrative tool for removing a single attendee — see
[Removing an attendee](#removing-an-attendee).

```bash
$env:TEST_BASE_URL="http://localhost:3000"; npm run test:api
npm run test:errors        # no database needed
npm run test:landing       # no database needed
npm run test:motion        # no database needed
```

`test:api` and `test:copy` deliberately do **not** read `.env`. They need
`ADMIN_USERNAME` and `ADMIN_PASSWORD` exported explicitly, so that a suite pointed
at production can never quietly authenticate with whatever local credentials
happen to sit in a file. `test:gate` does read `.env`, because its audit-trail
assertions need `DATABASE_URL`; when that is absent those four assertions **skip**
with an explanation rather than fail.

`test:errors`, `test:copy` and `test:desk` are bundled with esbuild first. They import
the real modules through the real resolver, because the `@/` alias in `src/` is a
Vite convention bare Node cannot resolve — bundling is what lets them exercise
shipped code rather than a copy. `test:errors` writes its full verdict table to
`scripts/error-matrix.csv` (git-ignored).

`test:copy`'s esbuild invocation marks `pg` external, because it now imports
`_fixtures.mjs` to clean up after itself and `pg` should be loaded at runtime rather
than bundled. That in turn means the bundled suite cannot use `_env.mjs`'s
module-relative `.env` lookup — the bundle lives in `node_modules/.tmp/`, so
`import.meta.url` no longer points at the repository. `loadEnv` therefore takes an
optional root, and `purgeTestAttendeesOnce` passes `process.cwd()`, which is the
project root for anything run through an npm script. A `.env` lookup that silently
finds nothing is how a cleanup step ends up quietly not running.

`test:export` imports the real `downloadAttendanceCsv` and stubs only the two browser
globals it touches, so the assertions are on shipping code rather than a copy that
could drift. It hands the function a log containing **both** days on purpose: records
that all shared a day would let a filter ignoring the day argument entirely still
pass every check.

`test:roles` provisions its staff accounts by running `scripts/manage-staff.mjs`,
the same path a human uses, and deletes them afterwards. So it asserts on the real
provisioning route and on the real audit rows — not on an INSERT the suite wrote
itself, which nothing else in the codebase would ever produce. It needs
`DATABASE_URL`.

It also drops the `admins_role` CHECK constraint to write a third role, checks that
such an account is treated as `gate` rather than `owner`, and puts the constraint
back. That is the assertion that matters most in the file: `adminRole` decides what
an unrecognised value means, and treating it as `owner` would be a silent privilege
escalation the moment anyone widened the role list.

`test:day` needs no database and no server. It exists because calendar arithmetic is
the one part of this feature that can fail *silently* — a timezone mistake files
every morning scan under the previous day and reports nothing — so it is pinned to
fixed dates rather than run against "now". That includes the rollover minute in
both directions and the node-pg `Date` regression described above.

The static suites (`landing`, `motion`, `scan`, `desk`) read the source rather than
driving a browser, because the defects they guard are structural: state written
but never read, focus restored on a path where it must not be, a control hidden
behind a breakpoint, a "Forgot password?" link creeping back. None of those are
visible to an API-level test — the request succeeds and the row is written either
way.

`test:desk` earned its place immediately: it caught that a phone number typed with
its country code — `+91 83103 29525`, which is how staff copy numbers out of a
contacts app — matched nobody, because the stored value is the bare ten digits.
The desk would have told someone their own number was unregistered.

### Cleaning up after a test run

The suites now clean up after themselves — see
[Test fixtures must not outlive the run](#test-fixtures-must-not-outlive-the-run).
Running one against production should leave the roster exactly as it was, and that
is asserted by running the full set and then counting.

`node scripts/clean-test-data.mjs` remains as a backstop, for `npm run load:test`
(which registers hundreds of attendees and does not clean up itself) and for a suite
killed hard enough that its own cleanup never ran. It is scoped to recognisable
names and prefixes, never a blanket delete: a blanket `delete from attendees` is
exactly how a real registration gets destroyed by a test run — and it did, once.

**Sessions are deleted first, and that ordering is load-bearing.**
`sessions.subject_id` carries no foreign key — one column serves both attendee
and admin sessions — so deleting an attendee does *not* take its sessions with it.
Deleting only the attendee rows leaves a live session pointing at an account that
no longer exists.

It is not a security hole: `GET /attendee/session` resolves the subject and
returns `null` when it is gone, so the holder is treated as anonymous. But the
rows are never reclaimed, because the cold-start purge only removes sessions that
have **expired**, and a test session's lifetime has not run out. Every run against
a live database therefore leaks a few more, and they accumulate indefinitely —
54 had built up before this was found. The cleanup script now reports
`orphan_sessions` in its summary so the count cannot quietly climb again.
`purgeTestAttendees` deletes sessions for the same reason.

### Removing an attendee

```bash
node scripts/remove-attendee.mjs "Name" --dry-run   # inspect only
node scripts/remove-attendee.mjs "Name"             # remove
```

Removes the attendee, their attendance row and their sessions in one transaction,
so a partial delete — attendance gone, attendee still present, sessions stranded —
cannot happen. It prints ready-to-run `INSERT` statements afterwards, so a
mistaken removal is recoverable without a backup.

It **refuses to guess** when a name matches more than one account. Ambiguity is a
stop rather than a coin flip: deleting the wrong person's registration is not
recoverable from here, and two people at an event can share a name.

Note that attendance is append-only by design, and this is the documented
exception — `db/schema.sql` states that the only way to undo a record is to delete
the row out of band. Removing an attendee therefore removes real attendance
history, and the person can be scanned and marked again afterwards, since the
unique index goes with the row.

### Running the HTTP suites

`test:api`, `test:gate`, `test:copy`, `test:roles` and `test:perday` all drive a real
server. Against a hosted deployment, export `TEST_BASE_URL` and the admin
credentials:

```bash
node dev-api.mjs    # local harness, then, in another shell:
$env:TEST_BASE_URL="http://localhost:3000"
$env:ADMIN_USERNAME="event.control"; $env:ADMIN_PASSWORD="…"
npm run test:api; npm run test:gate; npm run test:copy
npm run test:roles; npm run test:perday
```

`test:perday` moves the event day with the owner override rather than waiting for
October, which is both how the day-two path gets exercised before it happens and the
reason it needs `DATABASE_URL`. It restores the original override on the way out,
including after a crash.

`dev-api.mjs` serves the serverless function on `:3000` with no proxy in the path,
which is the only way to exercise anything that depends on the real caller IP —
Vercel **replaces** `x-forwarded-for` rather than appending to it, so deployed,
every caller collapses into one shared bucket.

That shared bucket used to matter: the retired reset endpoint was rate limited per
IP and the suite spent a chunk of that budget on each run, so it checked the
budget first and skipped the section when it was already spent rather than
reporting a cascade of 429s that read like a broken endpoint. The route no longer
exists, so `test:gate` no longer needs the workaround.

---

## Security

- **The QR is signed** with an HMAC over the SEN, verified in constant time. It
  prevents a screenshot of someone else's pass being edited into a different SEN
  before scanning; it is not what authorises attendance.
- **Check-in is single-use**, enforced by a unique index rather than a prior read.
- **Login does not leak account existence** — unknown name/phone and wrong
  password return the same status and the same message.
- **Sessions are httpOnly cookies.** The client never sees a token, and the
  cookie lifetime and the database row derive from the same day count, so the
  browser cannot forget a session the server still honours.
- **Admin authorisation is enforced server-side.** The client only hides UI. Staff
  roles are re-read from the database on every request, so a demotion takes effect
  immediately rather than whenever a cookie expires.
- **There is no unauthenticated password change.** Recovery requires an admin
  session, is identified by SEN, re-applies the registration password rules, and
  revokes every session belonging to the attendee in the same transaction that
  writes the new hash and the audit row.
- **Every request is time-bounded**, so a stalled connection cannot strand
  someone on a screen with no way forward.
- **`TICKET_SECRET` and `DATABASE_URL` are marked sensitive** in Vercel.
  `VITE_*` variables deliberately are not — Vite inlines them into the public
  bundle and Vercel rejects secret visibility for them.

### What happens when something breaks

Every failure mode was checked by breaking it on purpose rather than reasoned about.

**A render crash.** React unmounts the entire tree when a component throws while
rendering, so before this was added a single bad render was a permanent white
screen — no explanation, no navigation, nothing in the console unless DevTools
happened to be open. On a phone at a registration desk that reads as "the website is
down", and the person whose job it is to fix it has no way to tell it was one bad
render rather than the whole site. `src/components/ErrorBoundary.tsx` catches it and
shows a recovery panel with a retry and a link to each door, so a failure in one
portal cannot lock somebody out of the other. It does **not** retry automatically: a
render that threw once from bad data throws again on the same data, and a reload
loop at the gate looks exactly like the outage it replaced. Verified by crashing
`LandingView` on purpose and loading the built bundle.

**A server-side throw.** Every route runs inside one `try`, and anything that is not
an `ApiError` becomes a clean `500 {code: 'unknown'}` with human copy. Stack traces
and SQL never reach the client. Probed with 26 hostile requests — garbage cookies, a
session cookie presented to the wrong door, SQL injection in a SEN, prototype
pollution, `__proto__` in a query string, path traversal, a 4 000-character path,
arrays and bare strings where objects belong, numeric coercion, RTL overrides,
emoji, `TRACE` — and **zero** returned a 5xx, a non-JSON body, or an internal.

**A stalled request.** `fetch` has no default timeout, so a connection that stalls
(captive portal, mobile data dropping mid-request) leaves the promise pending
*forever*. That is worst on the session probe, because `AttendeeProvider` only sets
a status in `.then` or `.catch` — an unsettled probe holds the boot screen
indefinitely, so an attendee on bad wifi could not reach the sign-in form at all.
Every request is bounded with `AbortSignal.timeout`, on a shorter budget for the
probe that gates first paint than for writes that do real work.

**Connection exhaustion.** `db()` returns a module-level singleton capped at five
connections with a 10-second connect timeout, so a warm lambda reuses sockets
instead of opening one per request and a Neon hiccup fails fast rather than hanging.

**A camera that misbehaves.** The decoder is imported on demand inside a `try`, and
permission denial, an insecure context and an absent camera each resolve to a
distinct state that degrades to typed SEN entry. The door is never blocked by a
browser quirk.

**Measured under load**, against production:

| Phase                                    | Result                                   |
| ---------------------------------------- | ---------------------------------------- |
| 350 registrations, concurrency 25        | 350/350 · p50 1.2s · max 3.3s            |
| 350 dashboard loads, concurrency 25      | 350/350 · p50 2.3s · max 3.5s            |
| 350 logins (bcrypt compare)              | 350/350 · p50 1.0s · max 3.2s            |
| 350 registrations fired simultaneously   | 350/350 · 5.5s wall clock, none rejected |

That last row is the one that matters: the platform **queues** excess concurrency
rather than rejecting it, so the failure mode under a rush is slow, not down.

### Known limits

- **Sign-in is not rate limited,** for either door. It is bcrypt-backed, so brute
  force is expensive but not blocked. Worth adding if the portal is public before
  the event — and it matters more now, since removing the reset endpoint took away
  the only unauthenticated route that was ever heavily probed.
- **`day_override` has no expiry and no owner.** It is one global switch on the live
  event, and nothing in the product can tell a deliberate pin from a leftover one —
  a stale pin silently changes which day every scan files under, which is how the
  live event was found pinned to day two on 2026-10-07. The scan panel says "Pinned
  by an organiser", so it is visible, but there is no way to ask *how long it has
  been pinned*. A `pinned_at` column and an "auto-expire at the end of the event"
  default would remove the whole class. Until then: **check the Programme tab shows
  Attendance Day on `Auto`** before the event, and after any test run against
  production.
- **An owner can take over any attendee account by design.** Setting a password
  is a privileged act, and the audit trail records who did it rather than
  preventing it. That is inherent to desk-mediated recovery; the compensating
  control is that an admin session is the only door, not a phone number — and that
  a `gate` volunteer cannot do it at all.
- **A password set at the desk is known to two people.** The attendee should
  change it afterwards once a self-service route exists — but there is currently
  none, so in practice it stays as the desk set it. Worth revisiting if the
  portal is reused.
- Neon free tier auto-suspends after roughly 5 minutes idle, costing about a
  second on the first request afterwards. A paid plan removes it.

### Before the event

1. **Rotate the database password.** The Neon connection string was exposed in
   plaintext during development. Reset the password in the Neon console, then
   update `DATABASE_URL` in Vercel.
2. **Store both staff passwords in a password manager.** They were shown once at
   provisioning and are not recoverable — only their bcrypt hashes exist. Everything
   ever pasted in chat during development has been rotated and retired.
3. **Share the gate credential, not the owner one.** There is exactly one of each,
   both named for the role rather than the person holding it:

   | Username       | Role   | Display name       | Reaches                                   |
   | -------------- | ------ | ------------------ | ----------------------------------------- |
   | `event.control` | owner | Event Operations   | Everything, including the roster and password resets |
   | `gate`          | gate  | Registration Desk  | Scan, the attendance log, the teams — nothing else |

   Whoever is on the door gets `gate`. Nobody else should hold it, and no personal
   name appears on either account — the audit trail records a role, which is also
   what makes a shared desk credential defensible.
4. **Replace the placeholder logo** — `public/fetch-ai.svg`.
5. **Replace the placeholder agenda speakers and teams** in `db/seed.sql`, then
   re-run `npm run db:setup`.

---

## Publishing safely

`npm run scan:secrets` scans exactly the file set git would publish — not the
working directory — for Postgres connection strings, Neon keys, provider tokens,
private key blocks and admin password literals. It also fails if `.env`,
`.vercel`, `node_modules` or `dist` are tracked at all.

A tracked `.env` full of placeholders still has to fail: someone will eventually
paste a real value into it.

The script is named `scan:secrets` rather than `prepublish` on purpose. npm treats
`prepublish` as a lifecycle hook and runs it on **every** `npm install` — which put
this scan in the path of Vercel's build, where there is no `.git` to enumerate, so
it refused and failed the deploy. A check that only makes sense before a human
pushes must not be something an installer can trigger.

## Deployment

```bash
npm run build          # tsc -b && vite build && node scripts/build-vercel.mjs
vercel deploy --prod
```

`BrowserRouter` means the host must rewrite unknown paths to `index.html`. The
Build Output `config.json` routes `filesystem` first, then `/api/*` to the
function, then everything else to `/index.html` — so the API is matched before the
SPA catch-all and a broken function surfaces as an error rather than a 200 with
the wrong body.

Bundle sizes: main chunk 344 KB (105 KB gzip); the ZXing scanner is a separate
477 KB chunk (125 KB gzip) loaded only when an admin opens the camera.

Static assets are served `public, max-age=0, must-revalidate`. Vercel overrides
any `cache-control` set for files under `.vercel/output/static`, so the browser
revalidates with an ETag and receives a 304 — correct, if not maximal. Immutable
caching for hashed assets would need a CDN in front that leaves the header alone.
