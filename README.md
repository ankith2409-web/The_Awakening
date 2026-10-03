# THE AWAKENING — Access Portal

Attendee registration, a per-person QR entry pass, live event status, and a
separate admin portal for scanning SEN barcodes at the door.

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
    ForgotPasswordView.tsx
    admin/                 AdminLoginView, AdminPortalView

server/                The backend. Deliberately NOT named `api/` — see below.
  [...route].ts          All endpoints, one serverless function
  _lib/
    db.ts                 Pooled pg client
    auth.ts               bcrypt, sessions, httpOnly cookies
    http.ts               ApiError taxonomy, JSON and body parsing
    identifiers.ts        Phone/SEN normalisation (mirrors src/domain/phone.ts)
    ticket.ts             HMAC ticket signing, constant-time verification
    reset.ts              Password-reset rate limiter

db/
  schema.sql           Tables, unique indexes, CHECK constraints (idempotent)
  seed.sql             Event, agenda, teams (idempotent)

scripts/               Build, database setup, test suites, load tooling
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
| `attendance`               | append-only; unique index on `attendee_id`                     |
| `sessions`                 | SHA-256 token hash, `kind`, `expires_at`; expired rows purged |
| `admins`                   | bcrypt hashes, seeded from environment                        |
| `password_reset_attempts`  | rate-limit ledger, per phone and per IP                       |
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
| `POST`  | `/attendee/password/reset` | `{ phone, password }`                 | rate limited    |
| `GET`   | `/attendee/ticket`         | —                                     | attendee        |
| `GET`   | `/attendee/attendance`     | —                                     | attendee        |
| `GET`   | `/admin/session`           | —                                     | optional        |
| `POST`  | `/admin/login`             | `{ username, password }`              | —               |
| `POST`  | `/admin/logout`            | —                                     | admin           |
| `GET`   | `/admin/attendees`         | —                                     | admin           |
| `GET`   | `/admin/attendance`        | —                                     | admin           |
| `POST`  | `/admin/attendance`        | `{ sen }`                             | admin           |
| `PATCH` | `/admin/agenda/:id`        | `{ status }`                          | admin           |
| `PATCH` | `/admin/event`             | `{ phase }`                           | admin           |

Two independent providers, not one: attendee and admin are **separate doors** with
separate credentials, and neither can authorise the other. An anonymous call to
any `/admin/*` route returns 403.

`PATCH /admin/agenda/:id` returns the single updated `AgendaItem`;
`PATCH /admin/event` returns the whole `EventInfo`, which is what the caller
replaces its state with. Attendance rows come back camelCase (`attendeeId`) so
the admin log can resolve each row to a person.

---

## Core behaviour

### Attendance is scan-only and append-only

`POST /admin/attendance` is the only route that can create a record. There is no
update, no delete, and no edit control anywhere in the UI — a mistake is
corrected by a fresh scan, not by amending history.

The write is a single atomic statement guarded by a unique index:

```sql
insert into attendance (sen, attendee_id, gate)
select sen, id, 'Gate A' from attendees where id = $1
on conflict (attendee_id) do nothing
returning ...
```

`create unique index one_attendance_per_attendee on attendance (attendee_id)` is
the real guard, so two scanners hitting the same badge at the same instant cannot
both insert. A SELECT-then-INSERT would leave a race window there.

A SEN matching no registered attendee is rejected, so the roll cannot fill with
people who never registered.

**Export** downloads a CSV of SEN numbers only — one value per row, no header, no
name, no phone, no time. The header is omitted deliberately: the file is meant to
be pasted into a column or uploaded to a system that already knows what the values
are, where a header row would become a bogus entry. CSV rather than `.xlsx`
because it opens natively in Excel, needs no library, cannot break on a malformed
cell, and carries a UTF-8 BOM so Excel detects the encoding.

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

### Password reset

`/forgot-password`, attendee portal only.

**This reset is unverified.** There is no OTP, no email and no security question:
a phone number alone is enough to set a new password. This was an explicit
organiser decision. It is a genuine account-takeover path — knowing someone's
number lets you take their account and present their pass — and is recorded here
rather than buried.

What the endpoint does instead of verifying:

| Control                                        | Why                                                    |
| ---------------------------------------------- | ------------------------------------------------------ |
| 5 attempts per number per hour                 | One attacker grinding one known number                |
| 20 attempts per caller IP per hour             | One host sweeping the whole roster                    |
| Identical status **and message** either way    | Cannot be used to enumerate the roster                 |
| A dummy bcrypt compare on a miss               | Response time does not leak existence either           |
| Successful reset deletes that attendee's sessions | A takeover is visible to whoever it displaced        |
| A successful attempt **counts** toward the limit | Guessing right buys no extra attempts                |

The last row is load-bearing. An earlier version cleared a number's history on
success, so the count never reached the limit and any caller could reset the same
account indefinitely. There is deliberately no clear-on-success helper, and a test
asserts the limit engages.

Rate-limit state lives in Postgres rather than process memory: serverless
instances are ephemeral and unshared, so an in-memory counter would reset on every
cold start and the effective limit would be "however many guesses fit in one
function's lifetime".

**For real verification**, the change is contained — put an SMS OTP in front of
this endpoint (MSG91, Fast2SMS and Twilio all send to Indian numbers). Nothing
else needs to move.

The endpoint is being probed against the live site; the per-IP limiter has held at
exactly its configured ceiling. To see who is calling:

```sql
select ip, count(*) as attempts, max(created_at) as last_seen
  from password_reset_attempts
 group by ip
 order by attempts desc, last_seen desc;
```

### Route guard

`Guard` lets through **only** the named status and redirects everything else,
which is counter-intuitive: `when="active"` on `/dashboard` would bounce
anonymous visitors to `/login`, which is fine, but the same value on `/` would
bounce them to `/dashboard`, whose own guard bounces them on to `/login`, and the
landing page would never render at all. Hence `/login`, `/register` and
`/forgot-password` are all `when="anonymous"`.

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
| Admin tabs, attendance, teams  | Cross-fade and stagger                         |
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
  play. Tabs, attendance and teams animate; the scan panel does not.

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
| `test:gate`     | 23          | yes      | Signature verification, the `printed` fallback, every reset guarantee |
| `test:copy`     | 26          | yes      | Every error code renders as human copy; specific wording survives |
| `test:errors`   | 250 inputs  | no       | Every field rule, plus client/server agreement on accept, normalisation and rendering |
| `test:landing`  | 40          | no       | Entry points clear a phone; footer destinations; links open safely |
| `test:motion`   | 22          | no       | No layout animation; durations short; scan panel still; stagger capped |
| `test:scan`     | 20          | no       | Confirmation rendered, not red, not timed out; camera scans do not steal focus |
| `test:phone`    | 24          | no       | Phone normalisation, problem messages, client/server parity |
| `test:dates`    | 18          | no       | Two-day range and per-day headings, timezone-safe          |

```bash
$env:TEST_BASE_URL="http://localhost:3000"; npm run test:api
npm run test:errors        # no database needed
npm run test:landing       # no database needed
npm run test:motion        # no database needed
```

`test:errors` and `test:copy` are bundled with esbuild first. They import the real
modules through the real resolver, because the `@/` alias in `src/` is a Vite
convention bare Node cannot resolve — bundling is what lets them exercise shipped
code rather than a copy. `test:errors` writes its full verdict table to
`scripts/error-matrix.csv` (git-ignored).

The static suites (`landing`, `motion`, `scan`) read the source rather than
driving a browser, because the defects they guard are structural: state written
but never read, focus restored on a path where it must not be, a control hidden
behind a breakpoint. None of those are visible to an API-level test — the request
succeeds and the row is written either way.

### Cleaning up after a test run

The suites register real attendees and write real attendance rows, so a run
against a live database leaves records on the admin roster.
`node scripts/clean-test-data.mjs` removes them, scoped by name and prefix.

It is scoped rather than global because a blanket `delete from attendees` is
exactly how a real registration gets destroyed by a test run — and it did, once.
Suites therefore register under recognisable names; any suite adding a fixture
must either reuse an existing name or pick a prefix listed in `TEST_PREFIXES`.

### Rate limits and tests

Vercel **replaces** `x-forwarded-for` with the real client IP rather than
appending to it, so a client that sets its own value is ignored. Locally there is
no proxy, so a test can set the header freely; deployed, every caller — the suite
included — collapses into one shared bucket.

`test:gate` therefore checks the shared budget on its first real reset call and
**skips the reset section** with an explanation if it is already spent, rather
than reporting a cascade of 429s that read like the endpoint is broken. To
exercise that dimension for real, run it against the local harness:

```bash
node dev-api.mjs    # then, in another shell
$env:TEST_BASE_URL="http://localhost:3000"; npm run test:gate
```

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
- **Admin authorisation is enforced server-side.** The client only hides UI.
- **Every request is time-bounded**, so a stalled connection cannot strand
  someone on a screen with no way forward.
- **`TICKET_SECRET` and `DATABASE_URL` are marked sensitive** in Vercel.
  `VITE_*` variables deliberately are not — Vite inlines them into the public
  bundle and Vercel rejects secret visibility for them.

### Known limits

- **Sign-in is not rate limited.** It is bcrypt-backed, so brute force is
  expensive but not blocked. The reset endpoint *is* limited; sign-in is not.
  Worth adding if the portal is public before the event.
- **The reset endpoint is unverified by design** and is being probed. The per-IP
  limiter is currently the only control between an attacker and the roster.
- Neon free tier auto-suspends after roughly 5 minutes idle, costing about a
  second on the first request afterwards. A paid plan removes it.

### Before the event

1. **Rotate the database password.** The Neon connection string was exposed in
   plaintext during development. Reset the password in the Neon console, then
   update `DATABASE_URL` in Vercel.
2. **Rotate the admin password**, which was likewise exposed.
3. **Replace the placeholder logo** — `public/fetch-ai.svg`.
4. **Replace the placeholder agenda speakers and teams** in `db/seed.sql`, then
   re-run `npm run db:setup`.

---

## Publishing safely

`npm run prepublish` scans exactly the file set git would publish — not the
working directory — for Postgres connection strings, Neon keys, provider tokens,
private key blocks and admin password literals. It also fails if `.env`,
`.vercel`, `node_modules` or `dist` are tracked at all.

A tracked `.env` full of placeholders still has to fail: someone will eventually
paste a real value into it.

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