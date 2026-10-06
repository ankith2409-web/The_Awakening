/**
 * The display-name rule.
 *
 * Deliberately duplicated from `server/_lib/identifiers.ts` rather than imported,
 * for the same reason `phone.ts` is: the client bundle and the serverless function
 * are built by different toolchains, and sharing a module would couple the Vercel
 * build to this project's TypeScript path aliases. `scripts/error-matrix.mjs`
 * asserts the two agree on accept/reject across every case, which is the only
 * reason a duplicated rule is safe — that test caught the two drifting apart while
 * the server had no name rule at all.
 *
 * The full reasoning lives on the server copy. The short version: a name is read
 * aloud at a door and printed on a roster, so emoji and right-to-left overrides are
 * a legibility and identity problem rather than a style preference.
 */

export function nameProblem(raw: string): string | null {
  const trimmed = raw.trim()

  if (trimmed === '') return 'Name is required.'

  // Emoji before the length check: a lone `✅` is one code point, and a
  // length-first order would answer "use at least 2 characters" to somebody who
  // typed a party hat on purpose.
  if (hasEmoji(trimmed)) return 'No emoji in a name, please.'

  if (trimmed.length < 2) return 'Use at least 2 characters.'
  if (trimmed.length > 60) return 'Use 60 characters or fewer.'

  if (!NAME_PATTERN.test(trimmed)) return 'Use letters only.'

  return null
}

/**
 * Must START with a letter.
 *
 * Allowing a leading combining mark let a name made only of marks through: it
 * matches nothing else, so it was accepted, and it renders on the roster as an entry
 * that looks blank. No script starts a word with a combining mark, so requiring a
 * letter first costs nothing — the vowel signs in Devanagari, Tamil, Telugu,
 * Kannada, Malayalam and Bengali all come after their consonant.
 */
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}.' -]*$/u

/**
 * Detects emoji, including the parts that are not pictographs on their own.
 *
 * A naive `/\p{Extended_Pictographic}/u` misses the sequences that matter most,
 * because the pictograph is only one code point of several: skin-tone modifiers,
 * zero-width joiners gluing a family together, regional indicators forming a flag,
 * and text presentation selectors after a dingbat.
 */
function hasEmoji(value: string): boolean {
  return /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{200D}\u{FE0F}\u{20E3}\u{1F1E6}-\u{1F1FF}]/u.test(
    value,
  )
}