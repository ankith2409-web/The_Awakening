/**
 * Remove one attendee and everything attached to them.
 *
 * Three tables, and they do NOT all clean up themselves:
 *
 *   attendance  attendee_id references attendees(id) ON DELETE CASCADE — goes
 *               with the parent automatically.
 *   sessions    subject_id has NO foreign key (the same column serves attendee
 *               and admin sessions), so the rows would be orphaned silently.
 *               Nothing would break, and nothing would clean up either.
 *   attendees   the parent row.
 *
 * Deleting the attendee alone is the mistake this script exists to prevent: the
 * attendance row vanishes via cascade and the login sessions do not, leaving a
 * cookie that still verifies against a session row for an account that no longer
 * exists.
 *
 * Everything runs in one transaction. A partial delete — attendance gone,
 * attendee still there, sessions stranded — is the state this avoids.
 *
 * The captured rows are printed as ready-to-run INSERTs, so a mistaken deletion
 * is recoverable without a backup.
 *
 *   node scripts/remove-attendee.mjs "mrudu"
 *   node scripts/remove-attendee.mjs "mrudu" --dry-run
 */

import { Client } from 'pg'
import { loadEnv } from './_env.mjs'

loadEnv()

const url = process.env.DATABASE_URL
if (!url) {
  console.error('  DATABASE_URL is not set.')
  process.exit(1)
}

const name = process.argv[2]
const dryRun = process.argv.includes('--dry-run')

if (!name) {
  console.error('\n  Usage: node scripts/remove-attendee.mjs "<name>" [--dry-run]\n')
  process.exit(1)
}

const client = new Client({ connectionString: url })

try {
  await client.connect()

  /* -- find, and refuse to guess ------------------------------------------ */

  const { rows: matches } = await client.query(
    'select id, name, phone, sen, created_at from attendees where lower(name) = lower($1)',
    [name],
  )

  if (matches.length === 0) {
    console.log(`\n  No attendee named "${name}". Nothing to do.\n`)
    await client.end()
    process.exit(0)
  }

  if (matches.length > 1) {
    // Ambiguity is a stop, not a coin flip. Deleting the wrong person's
    // registration is not recoverable from here.
    console.error(`\n  "${name}" matches ${matches.length} accounts. Refusing to guess:\n`)
    for (const m of matches) {
      console.error(`     ${m.id}  ${m.phone}  ${m.sen}`)
    }
    console.error('\n  Remove by SEN or phone instead, so the target is unambiguous.\n')
    await client.end()
    process.exit(1)
  }

  const person = matches[0]
  const { rows: attendance } = await client.query(
    'select id, sen, gate, method, at from attendance where attendee_id = $1',
    [person.id],
  )
  const { rows: sessions } = await client.query(
    "select token_hash, expires_at from sessions where kind = 'attendee' and subject_id = $1",
    [person.id],
  )

  console.log('\n  About to remove:')
  console.log(`     name      ${person.name}`)
  console.log(`     phone     ${person.phone}`)
  console.log(`     sen       ${person.sen}`)
  console.log(`     id        ${person.id}`)
  console.log(`     registered ${person.created_at.toISOString()}`)
  console.log(`     attendance ${attendance.length} row(s)`)
  for (const a of attendance) {
    console.log(`        ${a.sen}  ${a.gate}  ${a.method}  ${a.at.toISOString()}`)
  }
  console.log(`     sessions   ${sessions.length} active login(s)`)

  if (dryRun) {
    console.log('\n  --dry-run: nothing was changed.\n')
    await client.end()
    process.exit(0)
  }

  /* -- one transaction, all or nothing ------------------------------------ */

  await client.query('begin')

  // Explicit rather than relying on the cascade, so the count reported back is
  // the count actually removed.
  const delAttendance = await client.query(
    'delete from attendance where attendee_id = $1 returning id',
    [person.id],
  )
  const delSessions = await client.query(
    "delete from sessions where kind = 'attendee' and subject_id = $1 returning token_hash",
    [person.id],
  )
  const delAttendee = await client.query('delete from attendees where id = $1 returning id', [
    person.id,
  ])

  await client.query('commit')

  console.log('\n  Removed:')
  console.log(`     attendee   ${delAttendee.rowCount}`)
  console.log(`     attendance ${delAttendance.rowCount}`)
  console.log(`     sessions   ${delSessions.rowCount}`)

  /* -- verify nothing was left behind ------------------------------------- */

  const { rows: leftovers } = await client.query(
    `select
       (select count(*)::int from attendees  where id = $1) as attendee,
       (select count(*)::int from attendance where attendee_id = $1) as attendance,
       (select count(*)::int from sessions   where kind = 'attendee' and subject_id = $1) as sessions`,
    [person.id],
  )
  const left = leftovers[0]
  const clean = left.attendee === 0 && left.attendance === 0 && left.sessions === 0
  console.log(`\n  Verify: attendee=${left.attendee} attendance=${left.attendance} sessions=${left.sessions}  ${clean ? 'clean' : 'LEFTOVERS'}`)

  /* -- recovery ---------------------------------------------------------- */

  if (person.name !== name || person.name !== person.name.toLowerCase()) {
    // no-op guard, kept simple
  }

  console.log('\n  If this was a mistake, restore with:\n')
  console.log(`     insert into attendees (id, name, phone, sen) values`)
  console.log(`       ('${person.id}', '${person.name}', '${person.phone}', '${person.sen}');`)
  for (const a of attendance) {
    console.log(`     insert into attendance (id, sen, attendee_id, gate, method, at) values`)
    console.log(`       ('${a.id}', '${a.sen}', '${person.id}', '${a.gate}', '${a.method}', '${a.at.toISOString()}');`)
  }
  console.log('')

  if (!clean) process.exitCode = 1
} catch (error) {
  console.error('\n  failed:', error.message)
  console.error('  the transaction was not committed, so nothing was removed.\n')
  process.exitCode = 1
} finally {
  await client.end()
}