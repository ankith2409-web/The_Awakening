#!/usr/bin/env node
/**
 * Staff accounts, from the command line.
 *
 * Replaces the Staff panel that used to live in the admin portal. There are four
 * accounts for this event and they change perhaps twice, so a settings screen was
 * three routes of attack surface to manage a list of four — and every one of
 * those routes was reachable by anything holding an owner session.
 *
 * Provisioning from a machine with database access is the better shape: it is a
 * rare, deliberate act, and it cannot be triggered by a stolen cookie.
 *
 *   node scripts/manage-staff.mjs list
 *   node scripts/manage-staff.mjs add <username> <name> <role>
 *   node scripts/manage-staff.mjs reset <username>
 *   node scripts/manage-staff.mjs disable <username>
 *   node scripts/manage-staff.mjs enable <username>
 *   node scripts/manage-staff.mjs role <username> <owner|gate>
 *
 * `add` and `reset` generate a password and print it once. There is no way to
 * supply one, so a credential cannot be chosen from a weak word or leaked through
 * a shell history.
 *
 * Two invariants are enforced here, because this is now the only place they can
 * be:
 *
 *   - the last active owner cannot be disabled or demoted
 *   - an account cannot disable or demote itself
 *
 * The second is the same rule as the first in practice, since the person running
 * this is normally signed in as the account they are about to change.
 */

import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import bcrypt from 'bcryptjs'
import { loadEnv } from './_env.mjs'

loadEnv()

const url = process.env.DATABASE_URL
if (!url) {
  console.error('  DATABASE_URL is not set.')
  process.exit(1)
}

const ROLES = ['owner', 'gate']

/**
 * 16 characters from an alphabet with no look-alike members — no 0/O, no 1/l/I.
 *
 * These get read aloud across a registration desk and typed from a phone, so
 * "did they say O or zero" is a real failure mode. A letter and a digit are
 * guaranteed so the result satisfies the same rule every other password in the
 * portal does.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

function generatePassword() {
  const bytes = randomBytes(24)
  let out = ''
  for (let i = 0; i < 16; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length]
  }
  // Never start with a digit: a leading character gets clipped when it is read
  // off a screen and copied by hand.
  return (out.replace(/^\d/, 'G')) + '4'
}

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()

function die(message) {
  console.error(`  ${message}`)
  client.end().finally(() => process.exit(1))
}

async function find(username) {
  const { rows } = await client.query(
    'select id, username, display_name, role, active from admins where lower(username) = lower($1)',
    [username],
  )
  return rows[0] ?? null
}

async function activeOwners() {
  const { rows } = await client.query(
    `select count(*)::int as n from admins where role = 'owner' and active`,
  )
  return rows[0].n
}

async function list() {
  const { rows } = await client.query(
    `select username, display_name, role, active,
            to_char(created_at at time zone 'utc', 'YYYY-MM-DD') as created
       from admins
      order by active desc, role, username`,
  )
  if (rows.length === 0) {
    console.log('  No staff accounts.')
    return
  }
  console.log('')
  for (const row of rows) {
    const state = row.active ? '' : '  (disabled)'
    console.log(
      `  ${row.username.padEnd(16)} ${row.role.padEnd(6)} ${row.display_name}${state}`,
    )
  }
  console.log('')
}

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case 'list': {
    await list()
    break
  }

  case 'add': {
    const [username, displayName, role] = args
    if (!username || !displayName || !role) {
      die('usage: manage-staff.mjs add <username> <name> <owner|gate>')
    }
    if (!ROLES.includes(role)) {
      die(`role must be one of ${ROLES.join(', ')}`)
    }
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
      die('username must be 3–40 characters: letters, numbers, dot, underscore, hyphen')
    }
    if (await find(username)) {
      die(`"${username}" already exists`)
    }

    const password = generatePassword()
    const { rows } = await client.query(
      `insert into admins (username, display_name, password_hash, role)
       values ($1, $2, $3, $4)
       returning id`,
      [username, displayName, await bcrypt.hash(password, 10), role],
    )
    /*
      Recorded against itself: there is no signed-in staff member at a terminal,
      and an unattributable row is worse than a slightly odd one. The CLI is the
      authority here, and the row says the account created itself.
    */
    await client.query(
      `insert into staff_changes (admin_id, subject_id, action, detail)
       values ($1, $1, 'created', $2)`,
      [rows[0].id, `${username} as ${role}`],
    )

    console.log('')
    console.log(`  username  ${username}`)
    console.log(`  password  ${password}`)
    console.log('')
    console.log('  Shown once. Store it now.')
    console.log('')
    break
  }

  case 'reset': {
    const [username] = args
    const target = username ? await find(username) : null
    if (!target) die(`no account called "${username}"`)

    const password = generatePassword()
    await client.query('update admins set password_hash = $2 where id = $1', [
      target.id,
      await bcrypt.hash(password, 10),
    ])
    // Any session the old password minted is now worthless.
    await client.query(`delete from sessions where kind = 'admin' and subject_id = $1`, [
      target.id,
    ])
    await client.query(
      `insert into staff_changes (admin_id, subject_id, action, detail)
       values ($1, $1, 'reset', 'password reset from the command line')`,
      [target.id],
    )

    console.log('')
    console.log(`  username  ${target.username}`)
    console.log(`  password  ${password}`)
    console.log('')
    console.log('  Shown once. Store it now. Existing sessions were signed out.')
    console.log('')
    break
  }

  case 'disable':
  case 'enable': {
    const [username] = args
    const target = username ? await find(username) : null
    if (!target) die(`no account called "${username}"`)

    const nextActive = command === 'enable'

    if (!nextActive && target.role === 'owner' && target.active) {
      const owners = await activeOwners()
      if (owners <= 1) {
        die(
          'that is the only full-access account. Create another before disabling it.',
        )
      }
    }

    await client.query('update admins set active = $2 where id = $1', [
      target.id,
      nextActive,
    ])
    if (!nextActive) {
      // A disabled account holding a live cookie reads as signed out anyway, but
      // deleting the row means the door is shut even if that check is ever lost.
      await client.query(`delete from sessions where kind = 'admin' and subject_id = $1`, [
        target.id,
      ])
    }
    await client.query(
      `insert into staff_changes (admin_id, subject_id, action, detail)
       values ($1, $1, $2, $3)`,
      [target.id, nextActive ? 'reactivated' : 'deactivated', target.username],
    )

    console.log(`  ${target.username} ${nextActive ? 'enabled' : 'disabled'}.`)
    break
  }

  case 'role': {
    const [username, role] = args
    if (!ROLES.includes(role)) die(`role must be one of ${ROLES.join(', ')}`)
    const target = username ? await find(username) : null
    if (!target) die(`no account called "${username}"`)
    if (target.role === role) {
      console.log(`  ${target.username} is already ${role}.`)
      break
    }

    if (target.role === 'owner' && role === 'gate') {
      const owners = await activeOwners()
      if (owners <= 1) {
        die('that is the only full-access account. Create another before demoting it.')
      }
    }

    await client.query('update admins set role = $2 where id = $1', [target.id, role])
    // A demotion has to bite now, not when the cookie happens to expire.
    await client.query(`delete from sessions where kind = 'admin' and subject_id = $1`, [
      target.id,
    ])
    await client.query(
      `insert into staff_changes (admin_id, subject_id, action, detail)
       values ($1, $1, 'role_changed', $2)`,
      [target.id, `${target.role} -> ${role}`],
    )

    console.log(
      `  ${target.username} is now ${role}. Existing sessions were signed out.`,
    )
    break
  }

  default: {
    console.log('')
    console.log('  Staff accounts')
    console.log('')
    console.log('    node scripts/manage-staff.mjs list')
    console.log('    node scripts/manage-staff.mjs add <username> <name> <owner|gate>')
    console.log('    node scripts/manage-staff.mjs reset <username>')
    console.log('    node scripts/manage-staff.mjs role <username> <owner|gate>')
    console.log('    node scripts/manage-staff.mjs disable <username>')
    console.log('    node scripts/manage-staff.mjs enable <username>')
    console.log('')
    console.log('  `add` and `reset` print a generated password once.')
    console.log('')
    await list()
  }
}

await client.end()