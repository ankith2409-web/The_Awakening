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