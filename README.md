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
  lib/
    exportAttendance.ts    SEN-only CSV download
    motion.ts              Stagger cap, the one place it is defined
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
      AdminPortalView.tsx  Tabs: Scan, Attendance, Desk, Teams, Programme
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
| `attendance`               | append-only; unique on `(attendee_id, day)`                     |
| `sessions`                 | SHA-256 token hash, `kind`, `expires_at`; expired rows purged |
| `admins`                   | bcrypt hashes, `role` (`owner` / `gate`), `active`             |
| `staff_changes`            | append-only audit of who changed which staff account          |
| `password_changes`         | append-only audit of admin-mediated password changes          |
| `password_reset_attempts`  | retired; retained as a record of the old endpoint's probing   |
| `events`                   | one row                                                       |
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
| `POST`  | `/attendee/register`       | `{ name, phone, password, sen }`      | —               |
| `POST`  | `/attendee/logout`         | —                                     | attendee        |
| `GET`   | `/attendee/ticket`         | —                                     | attendee        |
| `GET`   | `/attendee/attendance`     | —                                     | attendee        |
| `GET`   | `/admin/session`           | —                                     | optional        |
| `POST`  | `/admin/login`             | `{ username, password }`              | —               |
| `POST`  | `/admin/logout`            | —                                     | admin           |
| `GET`   | `/admin/attendees`         | —                                     | **owner**       |
| `POST`  | `/admin/attendees/password`| `{ sen, password }`                   | **owner**       |
| `GET`   | `/admin/attendance`        | —                                     | admin           |
| `POST`  | `/admin/attendance`        | `{ sen }`                             | admin           |
| `PATCH` | `/admin/agenda/:id`        | `{ status }`                          | **owner**       |
| `PATCH` | `/admin/event`             | `{ phase }`                           | **owner**       |

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
replaces its state with. It takes `phase` and `dayOverride` independently, so
setting one does not clobber the other. Attendance rows come back camelCase
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
insert into attendance (sen, attendee_id, gate, method, day)
select sen, id, 'Gate A', $2, $3 from attendees where id = $1
on conflict (attendee_id, day) do nothing
returning id, sen, attendee_id as "attendeeId", gate, at, method, day
```

`create unique index one_attendance_per_attendee_day on attendance (attendee_id, day)`
is the real guard, so two scanners hitting the same badge at the same instant cannot
both insert. A SELECT-then-INSERT would leave a race window there.

The old index is **dropped**, not extended. `create unique index if not exists`
matches on the index NAME, so a differently-named replacement would have left both
in place and the old one would have silently kept rejecting every second-day scan.

A SEN matching no registered attendee is rejected, so the roll cannot fill with
people who never registered.

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
| Scan confirmation   | "Marked for day 1", plus time, gate and admission method  |
| Attendance log      | A Day / All days switch, defaulting to the active day      |
| Desk roster         | A `D1` / `D2` badge per attendee                           |
| Attendee dashboard  | One row per day, marked or not, with today called out      |
| SEN export          | Per day, with the day in the filename                      |

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

`src/domain/contact.ts` holds the address once. The footer contact link and the
password help both read it, because two literals of the same address is how one of
them ends up pointing at an inbox nobody reads — and on the password help that
failure is invisible until somebody is locked out of their own event pass.

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

228 assertions across 9 suites.

| Suite           | Assertions  | Database | Covers                                                    |
| --------------- | ----------- | -------- | --------------------------------------------------------- |
| `test:api`      | 55          | yes      | Real cookies, bcrypt, writes, scan conflicts, auth guards  |
| `test:gate`     | 28          | yes      | Signature verification, the `printed` fallback, admin-mediated recovery and its audit trail |
| `test:copy`     | 26          | yes      | Every error code renders as human copy; specific wording survives |
| `test:desk`     | 49          | no       | Roster search normalisation; the panel's structure; the password-help email; no self-service reset |
| `test:roles`    | 34          | yes      | Every owner-only route refused to `gate`; an unrecognised role fails closed; the CLI's guards |
| `test:day`      | 21          | no       | Calendar resolution in IST, pinned to fixed dates including the midnight rollover |
| `test:perday`   | 28          | yes      | One record per attendee per day; both days recorded; the lock on future days |
| `test:errors`   | 250 inputs  | no       | Every field rule, plus client/server agreement on accept, normalisation and rendering |
| `test:landing`  | 40          | no       | Entry points clear a phone; footer destinations; links open safely |
| `test:motion`   | 22          | no       | No layout animation; durations short; scan panel still; stagger capped |
| `test:scan`     | 20          | no       | Confirmation rendered, not red, not timed out; camera scans do not steal focus |
| `test:phone`    | 24          | no       | Phone normalisation, problem messages, client/server parity |
| `test:dates`    | 18          | no       | Two-day range and per-day headings, timezone-safe          |

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

The suites register real attendees and write real attendance rows, so a run
against a live database leaves records on the admin roster.
`node scripts/clean-test-data.mjs` removes them, scoped by name and prefix.

It is scoped rather than global because a blanket `delete from attendees` is
exactly how a real registration gets destroyed by a test run — and it did, once.
Suites therefore register under recognisable names; any suite adding a fixture
must either reuse an existing name or pick a prefix listed in `TEST_PREFIXES`.

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
$env:ADMIN_USERNAME="admin"; $env:ADMIN_PASSWORD="…"
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

### Known limits

- **Sign-in is not rate limited,** for either door. It is bcrypt-backed, so brute
  force is expensive but not blocked. Worth adding if the portal is public before
  the event — and it matters more now, since removing the reset endpoint took away
  the only unauthenticated route that was ever heavily probed.
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
2. **Rotate the admin password**, which was likewise exposed. It is currently the
   only account, and it is a full-access one — see below.
3. **Share the gate credential, not the owner one.** There is exactly one, and it
   is provisioned by `node scripts/manage-staff.mjs add gate "Registration Desk"
   gate`. Whoever is on the door uses that; nobody else should be holding it.
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