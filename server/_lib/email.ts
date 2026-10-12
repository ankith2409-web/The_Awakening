/**
 * Email normalisation and validation.
 *
 * Deliberately duplicated from `src/domain/email.ts` for the same reason
 * `server/_lib/identifiers.ts` duplicates `src/domain/phone.ts`: the client
 * bundle and the serverless function are built by different toolchains, and
 * sharing the module would couple the Vercel build to this project's TypeScript
 * path aliases. These are pure functions, so a duplicate is cheaper than a
 * deployment that fails to resolve an import.
 *
 * The two MUST NOT DISAGREE. The client renders this string while somebody is
 * typing; the API returns it when the client is bypassed. `test:errors` asserts
 * they agree on accept, normalisation and rendering, across the same inputs.
 */

/**
 * Long enough for a real address, short enough that it cannot be used as a
 * free-text field to push megabytes into a row nobody will read.
 */
const MAX_EMAIL_LENGTH = 254

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Says precisely what is wrong with an email address, or null when it is fine.
 *
 * The checks are ordered so the message names the FIRST problem rather than a
 * generic failure, because somebody fixing a typo wants to be told which part.
 *
 * On the shape: this is a practical check, not RFC 5322. Full conformance
 * accepts forms no mail provider will issue and rejects forms that work, so the
 * regex is the intersection of "plausible" and "what we will actually send to".
 * The authoritative test is whether Resend accepts the address, which is why a
 * delivery failure is reported as its own error rather than swallowed.
 */
export function emailProblem(raw: string): string | null {
  const value = normaliseEmail(raw)

  if (value === '') return 'Email address is required.'

  if (value.length > MAX_EMAIL_LENGTH) {
    return `That address is ${value.length} characters. Email addresses cannot be longer than ${MAX_EMAIL_LENGTH}.`
  }

  // A space anywhere is the single most common paste error, and the most
  // confusing one: a server would reject it with a bare "invalid address".
  if (/\s/.test(value)) {
    return 'An email address cannot contain a space. Check for a stray one.'
  }

  const at = value.lastIndexOf('@')
  if (at === -1) return 'An email address needs an @ — for example, name@example.com.'

  const local = value.slice(0, at)
  const domain = value.slice(at + 1)

  if (local === '') return 'There is nothing before the @.'

  if (local.length > 64) return 'The part before the @ is too long.'

  /*
    Checked rather than permitted. Every one of these appears in addresses that
    some mail provider accepts and others reject, so allowing them would produce
    failures the attendee sees as "your email bounced" rather than as a typo.

    Dot rules: no leading dot, no trailing dot, no two in a row.
  */
  if (local.startsWith('.') || local.endsWith('.')) {
    return 'The part before the @ cannot start or end with a dot.'
  }
  if (local.includes('..')) {
    return 'The part before the @ cannot contain two dots in a row.'
  }
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) {
    return "The part before the @ contains a character that isn't allowed."
  }

  if (domain === '') return 'There is nothing after the @.'

  if (domain.startsWith('.') || domain.endsWith('.')) {
    return 'The domain cannot start or end with a dot.'
  }
  if (domain.includes('..')) return 'The domain cannot contain two dots in a row.'
  if (domain.startsWith('-') || domain.endsWith('-')) {
    return 'The domain cannot start or end with a hyphen.'
  }
  if (!domain.includes('.')) return 'The domain needs a dot — for example, example.com.'
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) {
    return 'The domain contains a character that is not allowed.'
  }

  /*
    A domain whose last label is not letters is a typo far more often than it is
    a real address. `.co1`, `.c0m` and `.comm` are the common ones, and every
    mail provider rejects them.
  */
  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  if (tld.length < 2) return 'That domain ending does not look right.'
  if (!/^[A-Za-z]{2,}$/.test(tld)) {
    return 'The part after the final dot must be at least two letters — for example, "com" or "in".'
  }

  // Length of the whole thing, after normalisation.
  if (value.length > MAX_EMAIL_LENGTH) return 'That address is too long.'

  return null
}

export function isValidEmail(raw: string): boolean {
  return emailProblem(raw) === null
}