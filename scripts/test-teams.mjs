/**
 * Team registration, end to end, against a running API.
 *
 * Run with the dev API up:
 *   node --experimental-strip-types --no-warnings scripts/test-teams.mjs
 * `TEST_BASE_URL=https://the-awakening-portal.vercel.app/api` runs it against
 * production.
 *
 * Every case registers a real team or deliberately fails to, so it cleans up after
 * itself in a `finally` — a probe team left in the admin list on event day is worse
 * than no test at all.
 */

import { loadEnv } from './_env.mjs'

loadEnv()
import { Client } from 'pg'

const BASE = (process.env.TEST_BASE_URL ?? 'http://localhost:3000') + '/team/register'

/** Unique per run, so a second run never collides with the first. */
const RUN = process.env.TEAM_TEST_RUN ?? String(process.hrtime.bigint()).slice(-9)

let passed = 0
let failed = 0

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function call(body) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json = {}
  try {
    json = await res.json()
  } catch {
    json = {}
  }
  return { status: res.status, json }
}

const sen = (n) => `A866T${RUN}${n}`

function team(over = {}) {
  return {
    name: `Test Squad ${over.tag ?? 'A'}`,
    leaderName: 'Leader Person',
    leaderEmail: `leader-${RUN}-${over.tag ?? 'A'}@example.com`,
    leaderPhone: '9845012345',
    leaderSen: sen(over.n ?? 1),
    members: [
      { name: 'Mate One', sen: sen((over.n ?? 1) * 10 + 1) },
      { name: 'Mate Two', sen: sen((over.n ?? 1) * 10 + 2) },
    ],
    ...(over.patch ?? {}),
  }
}

/* -- the shape of a success ------------------------------------------------- */

const good = team({ tag: 'good', n: 1 })
const ok = await call(good)

check('a valid team registers', ok.status === 201, `got ${ok.status}`)
check('it answers ok', ok.json.ok === true)
check('the team comes back', ok.json.team?.name === good.name, JSON.stringify(ok.json.team ?? null))
check('with three members', ok.json.members?.length === 3, `got ${ok.json.members?.length}`)
check(
  'the leader is first and flagged',
  ok.json.members?.[0]?.isLeader === true && ok.json.members?.[0]?.sen === good.leaderSen,
  JSON.stringify(ok.json.members?.[0] ?? null),
)
check(
  'the teammates are not flagged',
  ok.json.members?.slice(1).every((m) => m.isLeader === false),
  JSON.stringify(ok.json.members?.slice(1) ?? null),
)
check(
  'no member carries the database column name',
  ok.json.members?.every((m) => m.is_leader === undefined),
  'a key named is_leader leaked into the response',
)

/* -- refusals --------------------------------------------------------------- */

const short = await call(
  team({ tag: 'short', n: 2, patch: { members: [{ name: 'Only Person', sen: sen(21) }] } }),
)
check('a team of two is refused', short.status === 422, `got ${short.status}`)
check(
  'and says how many a team has',
  /3 members/i.test(short.json.message ?? ''),
  JSON.stringify(short.json),
)

const dupWithin = await call(
  team({
    tag: 'dupw',
    n: 3,
    patch: {
      members: [{ name: 'First Person', sen: sen(31) }, { name: 'Second Person', sen: sen(31) }],
    },
  }),
)
check('two teammates sharing a SEN is refused', dupWithin.status === 422, `got ${dupWithin.status}`)

/*
  A teammate given THIS team's leader SEN.

  Note which SEN it uses. An earlier version passed the previous fixture team's
  leader SEN and asserted 422; the route answered 409, correctly, because that SEN
  really was on another team. The within-team duplicate check runs first, so a
  genuine clash inside one team is a 422 and a clash against the register is a 409
  — and those two are different faults with different fixes.
*/
const dupLeader = await call(
  team({
    tag: 'dupl',
    n: 4,
    patch: {
      members: [
        { name: 'Alpha Person', sen: sen(41) },
        { name: 'Beta Person', sen: sen(4) },
      ],
    },
  }),
)
check('a teammate sharing the leader SEN is refused', dupLeader.status === 422, `got ${dupLeader.status}`)
check(
  'and says the members need different SENs',
  /different SEN/i.test(dupLeader.json.message ?? ''),
  JSON.stringify(dupLeader.json),
)

/*
  Reusing a SEN that is already on a team.

  The member names are spelled out rather than abbreviated, because `nameProblem`
  refuses a single character — an earlier run of this suite used 'A' and 'B' and
  read the resulting 422 about member NAMES as a failure of the SEN check. The
  fixture, not the route, was wrong.
*/
const reused = await call(
  team({
    tag: 'reuse',
    n: 5,
    patch: {
      leaderSen: good.members[1].sen,
      members: [{ name: 'Alpha Person', sen: sen(51) }, { name: 'Beta Person', sen: sen(52) }],
    },
  }),
)
check('a SEN already on another team is a conflict', reused.status === 409, `got ${reused.status}`)
check(
  'and names the SEN rather than saying "invalid"',
  new RegExp(good.members[1].sen, 'i').test(reused.json.message ?? ''),
  JSON.stringify(reused.json),
)

const badEmail = await call(team({ tag: 'email', n: 6, patch: { leaderEmail: 'not-an-email' } }))
check('a bad leader email is refused', badEmail.status === 422, `got ${badEmail.status}`)

const badPhone = await call(team({ tag: 'phone', n: 7, patch: { leaderPhone: '12345' } }))
check('a bad leader phone is refused', badPhone.status === 422, `got ${badPhone.status}`)

/*
  A missing field is 400, not 422, and that is the portal's convention rather than
  this route's choice: `POST /attendee/checkin` answers 400 for a blank or absent
  field too. `requireString` throws before the per-field validators get a chance,
  and both public forms use it — so a leader and a student are told the same kind
  of thing for the same mistake.

  Asserted here so a future change to one route that forgets the other is caught.
*/
const blankName = await call(team({ tag: 'name', n: 8, patch: { name: '   ' } }))
check('a blank team name is refused', blankName.status === 400, `got ${blankName.status}`)

const missing = await call({ name: 'Only A Name' })
check('a body with nothing else is refused', missing.status === 400, `got ${missing.status}`)

/*
  And the same question to the check-in route, so the convention is pinned on both
  sides rather than assumed.
*/
const checkinBlank = await fetch(
  (process.env.TEST_BASE_URL ?? 'http://localhost:3000') + '/attendee/checkin',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '', phone: '9845012345', sen: sen(91) }),
  },
)
check(
  'and the check-in route answers the same way for a blank field',
  checkinBlank.status === blankName.status,
  `checkin ${checkinBlank.status}, team ${blankName.status}`,
)

/* -- the pass document ------------------------------------------------------- */

/*
  Rendered and READ, not merely generated.

  The pass had a bug that every other check in this repository passed: the member
  count line read `rows.length` where `rows` was the joined HTML string, so every
  pass said "1555 members" for a team of three. It typechecked, because the length
  of a string is a number. The API tests missed it, because they assert the
  response and not this document. It was caught by rendering a pass and looking at
  it.

  So the assertions here are on the rendered string, and they are the only ones in
  the suite that would have failed for that bug.
*/
const { teamPassHtml, teamPassSubject, teamPassText } = await import(
  '../server/_lib/teamPass.ts'
)

const PASS_TEAM = {
  name: 'Render Check Squad',
  leaderName: 'Pass Leader',
  leaderEmail: 'leader@example.com',
  leaderPhone: '9845012345',
  members: [
    { name: 'Pass Leader', sen: 'A866P000000001', isLeader: true },
    { name: 'Pass Member One', sen: 'A866P000000002', isLeader: false },
    { name: 'Pass Member Two', sen: 'A866P000000003', isLeader: false },
  ],
}

const pass = teamPassHtml(PASS_TEAM)

check('the pass says how many members there are, and it is right', /3 members/.test(pass),
  (pass.match(/(\d+) members/) ?? ['no count line'])[0])
check(
  'and the count is not the length of the document it was rendered into',
  !/1\d{3} members/.test(pass),
  (pass.match(/(\d+) members/) ?? [''])[0] + ' — that looks like a string length',
)
check('every SEN appears on the pass', PASS_TEAM.members.every((m) => pass.includes(m.sen)))
check('the team name appears on the pass', pass.includes(PASS_TEAM.name))
check('the leader is flagged on the pass', pass.includes('Team leader'))
check('the leader is listed first', pass.indexOf('Pass Leader') < pass.indexOf('Pass Member One'))
check('the subject names the team', teamPassSubject(PASS_TEAM).startsWith('Render Check Squad'))
check('the subject carries no newline, which some clients render literally',
  !/[\r\n]/.test(teamPassSubject(PASS_TEAM)))

/* -- user input is never live HTML -------------------------------------------- */

const hostile = teamPassHtml({
  ...PASS_TEAM,
  name: '<script>alert(1)</script> "Quoted" & Co',
  leaderEmail: 'a"b@example.com',
})
check('a <script> in a team name does not reach the document', !hostile.includes('<script>'))
check('a quote in an email is escaped', hostile.includes('&quot;') || !hostile.includes('a"b@'))
check('an ampersand in a team name is escaped', hostile.includes('&amp;'))

const plainText = teamPassText(PASS_TEAM)
check('the text part lists every SEN too', PASS_TEAM.members.every((m) => plainText.includes(m.sen)))
check('the text part is not empty of the essentials',
  plainText.includes('TEAM LEADER') && plainText.includes(PASS_TEAM.leaderEmail))

/* -- the gate is owner-only, and the list is not public ---------------------- */

const anonTeams = await fetch((process.env.TEST_BASE_URL ?? 'http://localhost:3000') + '/admin/teams')
check('the team list is not public', anonTeams.status === 401 || anonTeams.status === 403, `got ${anonTeams.status}`)

const anonEmail = await fetch((process.env.TEST_BASE_URL ?? 'http://localhost:3000') + '/admin/teams/email', {
  method: 'POST',
})
check(
  'nor is the pass button',
  anonEmail.status === 401 || anonEmail.status === 403,
  `got ${anonEmail.status}`,
)

/* -- cleanup ---------------------------------------------------------------- */

try {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  // By name, not by SEN prefix: this is a table of people.
  const { rows } = await client.query(
    "delete from teams where leader_email like $1 returning leader_email",
    [`%-${RUN}-%@example.com`],
  )
  console.log(`\n  cleaned up ${rows.length} probe team(s)`)
  await client.end()
} catch (error) {
  console.log(`\n  cleanup failed: ${error.message}`)
  failed += 1
}

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
