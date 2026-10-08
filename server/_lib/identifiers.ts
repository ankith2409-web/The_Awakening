/**
 * Identity normalisation.
 *
 * Deliberately duplicated from `src/domain/phone.ts` rather than imported.
 * The client bundle and the serverless function are built by different
 * toolchains, and sharing the module would couple the Vercel build to this
 * project's TypeScript path aliases. These are pure functions, so a duplicate
 * is cheaper than a deployment that fails to resolve an import.
 */

export function normalisePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '')

  // Collapse +91 / 91 / 0-prefixed forms to ten digits.
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)

  return digits
}

export function isValidIndianMobile(value: string): boolean {
  return /^[6-9]\d{9}$/.test(normalisePhone(value))
}

/**
 * Says precisely what is wrong with a phone number, or null when it is fine.
 *
 * A catch-all "Enter a 10-digit mobile number" misleads the most common
 * mistake: someone typing `0545654587` has entered ten digits already, so
 * blaming the digit count sends them hunting for a fault they do not have. The
 * real problem is the leading zero.
 *
 * Mirrored in `src/domain/phone.ts`. The two must not disagree — the client
 * renders this string, and the API returns it on a bypassed client.
 */
export function phoneProblem(raw: string): string | null {
  const digits = normalisePhone(raw)

  if (digits === '') return 'Phone number is required.'

  if (digits.startsWith('0')) {
    return 'Mobile numbers do not start with 0. Remove it, or use your number with 91.'
  }

  if (digits.length !== 10) {
    return `Enter a 10-digit mobile number. You entered ${digits.length}.`
  }

  if (!/^[6-9]/.test(digits)) {
    return 'Indian mobile numbers start with 6, 7, 8 or 9.'
  }

  return null
}

/**
 * Extracts a SEN from a scanner payload.
 *
 * Hardware scanners are inconsistent: some emit the bare value, some wrap it
 * in a URL or `?code=`, some append a signature. A pass that fails at the gate
 * because of a stray wrapper would strand someone, so this unwraps in stages:
 *
 *   1. an explicit `?sen=` / `?code=` / `?id=` parameter
 *   2. a bare identifier token found anywhere in the payload
 *   3. otherwise the cleaned input, so the caller can reject it clearly
 *
 * A `.` separates the SEN from a ticket signature, so it is always dropped.
 */
export function normaliseSen(raw: string): string {
  const upper = raw.trim().toUpperCase()

  const param = upper.match(/[?&](?:SEN|CODE|ID)=([^&#\s]+)/)
  if (param?.[1]) return canonical(param[1])

  const token = upper.match(/\b([A-Z]{0,4}[-_]?\d{4,12})\b/)
  if (token?.[1]) return canonical(token[1])

  return canonical(upper)
}

function canonical(value: string): string {
  return value.split('.')[0].replace(/[^A-Z0-9]/g, '')
}

/**
 * Deliberately permissive: 4+ alphanumerics containing at least one digit.
 *
 * College SENs vary by institution. This event's are Amity University codes —
 * a single letter followed by twelve digits, e.g. `A866175000012` — but other
 * formats exist (`22CS1RE0123`, `1RV21CS134`) and the full roster has not been
 * supplied yet. The database lookup is the real gate, so this check only exists
 * to reject obvious garbage before spending a round trip. Tightening it to the
 * Amity shape would catch typos earlier but would lock out anyone whose code
 * differs, which is a far worse failure at a registration desk.
 */
export function isValidSen(value: string): boolean {
  // Normalise first, so this accepts exactly what `normaliseSen` produces. The
  // gate runs it on the output of `normaliseSen` while the registration form
  // runs it on raw user input — without this, a lowercase or URL-wrapped SEN
  // would pass at the API and fail in the browser.
  const cleaned = normaliseSen(value)
  return /^[A-Z0-9]{4,24}$/.test(cleaned) && /\d/.test(cleaned)
}

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Use at least 8 characters.'
  if (!/[a-zA-Z]/.test(password)) return 'Include at least one letter.'
  if (!/\d/.test(password)) return 'Include at least one number.'
  return null
}

/**
 * Reduces a name to a form safe to COMPARE, without changing what is stored.
 *
 * Case and runs of whitespace are not part of somebody's name. The difference is
 * only in how it got typed, and treating it as part of the identity locks people out
 * of their own account.
 *
 * This was a live lockout. Registration accepts `Mary  Ann` — the validator allows
 * internal spacing — but the login compared the name exactly, so the same person
 * typing `Mary Ann` was refused with no way back: the only route is emailing the
 * organiser. The most natural way to type a name is the way that failed.
 *
 * Lowercased and whitespace-collapsed, nothing else. A misspelling, a different
 * spelling, or an added middle initial still fails, which is the point of having a
 * name as a second factor at all — knowing somebody's phone number should not be
 * enough to walk in with their pass.
 */
export function nameKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Says what is wrong with a display name, or null when it is fine.
 *
 * This did not exist. The register route took any non-empty string as a name, so
 * the browser's rule was the only thing enforcing it — and anything that did not go
 * through the browser form wrote straight through. Emoji are the visible case: the
 * client refused them while `POST /attendee/register` returned 201.
 *
 * Why it matters beyond tidiness: a name is what a gate volunteer reads aloud, what
 * appears on the roster an owner reads, and what is rendered on the dashboard next
 * to a QR pass. A row of pictographs is unreadable at a desk, and a name containing
 * a right-to-left override renders as the *end* of somebody else's name — the badge
 * says one thing and the screen says another.
 *
 * The pattern is `\p{L}\p{M}`, letters and combining marks, so `José`, `Ankit é` and
 * `山田太郎` all pass while digits, punctuation, symbols and emoji do not. `\p{M}`
 * is required rather than optional: without it a name in a script that composes its
 * accents — Devanagari, Tamil, Malayalam — is rejected for its own vowel signs.
 *
 * Mirrored in `src/auth/validation.ts`. `scripts/error-matrix.mjs` asserts the two
 * agree on accept/reject across 50 inputs, which is the only reason a duplicated
 * rule is safe here.
 */
export function nameProblem(raw: string): string | null {
  const trimmed = raw.trim()

  if (trimmed === '') return 'Name is required.'

  /*
    Emoji before the length check, deliberately.

    A single `✅` is one code point, so a length-first order answers "Use at least 2
    characters" — which sends somebody who typed a party hat on purpose looking for
    a length problem they do not have.
  */
  if (hasEmoji(trimmed)) return 'No emoji in a name, please.'

  if (trimmed.length < 2) return 'Use at least 2 characters.'
  if (trimmed.length > 60) return 'Use 60 characters or fewer.'

  if (!NAME_PATTERN.test(trimmed)) return 'Use letters only.'

  return null
}

/**
 * Letters and combining marks, and the name must START with a letter.
 *
 * The leading `\p{L}` rather than `\p{L}\p{M}` is what rejects a name made only of
 * combining marks. Those pass a marks-allowed pattern, match nothing else, and
 * render as an entry that looks blank on the roster — accepted, and useless.
 *
 * No script begins a word with a combining mark, so requiring a letter first costs
 * nothing: Devanagari, Tamil, Telugu, Kannada, Malayalam and Bengali all still pass,
 * because their vowel signs come after the consonant.
 */
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}.' -]*$/u

/**
 * Detects emoji, including the parts that are not pictographs on their own.
 *
 * A naive `/\p{Extended_Pictographic}/u` misses the sequences that matter most in
 * practice, because the pictograph is only one code point of several:
 *
 *   👍🏽          U+1F44D U+1F3FD   skin-tone modifier
 *   👨‍👩‍👧       U+1F468 200D ...     zero-width joiner gluing a family together
 *   🇮🇳          U+1F1EE U+1F1F3   regional indicators forming a flag
 *   ❤️           U+2764 FE0F        text presentation selector
 *
 * So the modifiers are matched as well. `\p{Extended_Pictographic}` covers the
 * pictographs and, since Unicode 11, the regional indicators; the explicit ranges
 * catch dingbats and the joiner.
 */
function hasEmoji(value: string): boolean {
  return /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{200D}\u{FE0F}\u{20E3}\u{1F1E6}-\u{1F1FF}]/u.test(
    value,
  )
}