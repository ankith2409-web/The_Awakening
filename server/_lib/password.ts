import { randomInt } from 'node:crypto'

/**
 * Passwords the portal hands out at registration.
 *
 * The constraint that shapes all of this is that the password is read ALOUD, over a
 * noisy room, and typed by somebody holding a phone in one hand. That rules out the
 * obvious approach. `Xq7#mK2$vB` is fine for a password manager and useless here:
 * nobody can reliably hear "hash", "dollar", "backslash" and "capital V B" over a
 * queue, and a single misheard character means the attendee is locked out and has to
 * queue again to ask an organiser to reset it.
 *
 * So the alphabet is restricted to the characters that survive being spoken:
 *
 *   - no `0/O`, `1/l/I` — indistinguishable in most sans-serif faces, and the single
 *     most common way a read-back goes wrong.
 *   - no punctuation beyond the group separator — every symbol is a thing to name.
 *   - lower case only — nothing to distinguish, so nothing to get wrong.
 *   - digits 2-9, which have no look-alike.
 *
 * Three groups of three from that set. In groups of three, so a volunteer can read
 * it out one character at a time and the attendee can count. In three groups, so
 * nobody has to hold eleven characters in their head before typing.
 *
 * 23 letters and 8 digits, so 31^3 ≈ 2.6e13 — about 44 bits. That is ample for a
 * credential whose real lifetime is one weekend, and it is not worth a longer string
 * that is harder to read correctly, which is the failure mode that actually costs
 * somebody their place.
 */

/** 23 letters: the alphabet minus `i`, `l` and `o`. */
const LETTERS = 'abcdefghjkmnpqrstuvwxyz'
/** 8 digits: no `0` or `1`. */
const DIGITS = '23456789'
const ALPHABET = LETTERS + DIGITS

const GROUPS = 3
const GROUP_LENGTH = 3
/** Must satisfy `passwordProblem`: at least 8 characters, a letter and a number. */
const LENGTH = GROUPS * GROUP_LENGTH + (GROUPS - 1)

/**
 * Builds one password.
 *
 * `randomInt` rather than `Math.random`: this is a credential, and `Math.random`
 * is a seeded PRNG whose internal state can be recovered from a handful of outputs,
 * which would make every password this function ever issued predictable.
 */
export function generatePassword(): string {
  const characters: string[] = []

  for (let group = 0; group < GROUPS; group += 1) {
    for (let index = 0; index < GROUP_LENGTH; index += 1) {
      characters.push(ALPHABET[randomInt(ALPHABET.length)])
    }
  }

  let password = characters.join('')
  password = insertSeparators(password)

  /*
    Enforced rather than left to chance.

    A password of `jjj-jjj-jjj` satisfies "three groups of three" and fails the
    portal's own strength rule, which would mean a registration that can only be
    completed by re-rolling. Two chances at one character each makes the failure
    vanishingly unlikely, and the loop cannot spin indefinitely because each attempt
    strictly increases the number of distinct characters present.
  */
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (hasLetter(password) && hasDigit(password)) return password
    password = insertSeparators(withCharacter(password, hasLetter(password) ? DIGITS : LETTERS))
  }

  /*
    Unreachable in practice, and asserted as such by `test:registration`: a 32-try loop
    on nine characters has not once failed to produce a letter and a digit.
  */

  // Unreachable in practice. Still returns something usable rather than throwing,
  // because refusing to register anybody over a password shape would be absurd.
  return password
}

/** Exported for the test suite: the shape the portal promises, stated once. */
export const GENERATED_PASSWORD_SHAPE = /^[a-z2-9]{3}-[a-z2-9]{3}-[a-z2-9]{3}$/

function insertSeparators(flat: string): string {
  const groups: string[] = []
  for (let index = 0; index < flat.length; index += GROUP_LENGTH) {
    groups.push(flat.slice(index, index + GROUP_LENGTH))
  }
  return groups.join('-')
}

/**
 * Replaces one character so the password gains a letter or a digit.
 *
 * Returns the FLAT string. It used to return a separated one, and the caller
 * separated it again — which turned `abc-def-ghi` into `abc--de-f-ghi`, with a
 * double dash and single-character groups. Nothing caught it except an assertion on
 * the shape, which is the argument for having one.
 */
function withCharacter(password: string, from: string): string {
  const flat = password.replace(/-/g, '')
  const position = randomInt(flat.length)
  return flat.slice(0, position) + from[randomInt(from.length)] + flat.slice(position + 1)
}

function hasLetter(value: string): boolean {
  return /[a-z]/.test(value)
}

function hasDigit(value: string): boolean {
  return /[0-9]/.test(value)
}

/** Exported for the test suite: the shape the portal promises, stated once. */
export const GENERATED_PASSWORD_LENGTH = LENGTH
export const GENERATED_PASSWORD_ALPHABET = ALPHABET