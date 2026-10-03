/**
 * Phone numbers — 10-digit Indian mobiles.
 *
 * Normalisation happens at the edge so the rest of the app only ever sees a
 * canonical string. Storing anything else would let "9876543210" and
 * "+91 98765 43210" become two different accounts.
 */

/** Strips separators and an optional +91 / 91 prefix. */
export function normalisePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '')

  // Drop a leading country code so both forms collapse to ten digits.
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)

  return digits
}

/**
 * Indian mobile numbers: ten digits, starting 6-9.
 * Deliberately anchored — no partial matches, no trailing characters allowed.
 */
export function isValidIndianMobile(value: string): boolean {
  return /^[6-9]\d{9}$/.test(normalisePhone(value))
}

/**
 * Says precisely what is wrong with a phone number, or null when it is fine.
 *
 * A single catch-all "Enter a 10-digit mobile number" is actively unhelpful for
 * the most common mistake. Someone typing `0545654587` has entered ten digits
 * already, so being told the digit count is wrong sends them hunting for a
 * problem they do not have. The real fault is the leading zero, and each cause
 * gets its own message.
 *
 * Mirrored in `server/_lib/identifiers.ts`; the two must not disagree.
 */
export function phoneProblem(raw: string): string | null {
  const digits = normalisePhone(raw)

  if (digits === '') return 'Phone number is required.'

  // Caught before the length check, because `0` is the digit people reach for
  // out of habit — "09876543210" is eleven digits and normalises correctly,
  // but a bare ten-digit "0…" has no valid number behind it.
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

/** Groups digits for display: 98765 43210 */
export function formatPhone(value: string): string {
  const digits = normalisePhone(value)
  if (digits.length !== 10) return value
  return `${digits.slice(0, 5)} ${digits.slice(5)}`
}

/* ------------------------------------------------------------------- SEN */

/**
 * Extracts a SEN from a scanner payload.
 *
 * Must stay behaviourally identical to `server/_lib/identifiers.ts` — the two
 * are separate builds so they are duplicated deliberately, but a divergence
 * would mean the registration form accepts a code the gate then rejects.
 *
 * Hardware scanners are inconsistent: some emit the bare value, some wrap it
 * in a URL or `?code=`, some append a signature. This unwraps in stages:
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
  // Destructured with a default: noUncheckedIndexedAccess makes `split()[0]`
  // optional, and `.replace` on undefined would throw at the gate.
  const [beforeSignature = ''] = value.split('.')
  return beforeSignature.replace(/[^A-Z0-9]/g, '')
}

/**
 * Deliberately permissive: 4+ alphanumerics containing at least one digit.
 * College SENs vary by institution. This event's are Amity University codes —
 * one letter and twelve digits, e.g. `A866175000012` — so this only rejects
 * obvious garbage. The database lookup is the real gate.
 */
export function isValidSen(value: string): boolean {
  // Normalise FIRST, then test.
  //
  // Testing the raw string made this disagree with the server on 13 inputs:
  // lowercase, surrounding whitespace, a `.signature` suffix and `?code=` URL
  // wrappers were all rejected here but accepted there. The signature and
  // query-parameter forms matter most — they are exactly what the gate scanner
  // emits, and what Chrome pastes in on autofill (autofill bypasses the form's
  // onChange, so nothing else would have uppercased it).
  const cleaned = normaliseSen(value)
  return /^[A-Z0-9]{4,24}$/.test(cleaned) && /\d/.test(cleaned)
}