/**
 * Email normalisation and validation.
 *
 * Deliberately duplicated from `server/_lib/email.ts` for the same reason
 * `src/domain/phone.ts` duplicates `server/_lib/identifiers.ts`: the client
 * bundle and the serverless function are built by different toolchains, and
 * sharing the module would couple the Vercel build to this project's path
 * aliases. These are pure functions, so a duplicate is cheaper than a
 * deployment that fails to resolve an import.
 *
 * The two MUST NOT DISAGREE. The client renders this string while somebody is
 * typing; the API returns it when the client is bypassed. `test:errors` asserts
 * they agree on accept, normalisation and rendering, across the same inputs.
 *
 * This copy is the one the browser runs, so it must not import anything.
 */

const MAX_EMAIL_LENGTH = 254

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function emailProblem(raw: string): string | null {
  const value = normaliseEmail(raw)

  if (value === '') return 'Email address is required.'

  if (value.length > MAX_EMAIL_LENGTH) {
    return `That address is ${value.length} characters. Email addresses cannot be longer than ${MAX_EMAIL_LENGTH}.`
  }

  if (/\s/.test(value)) {
    return 'An email address cannot contain a space. Check for a stray one.'
  }

  const at = value.lastIndexOf('@')
  if (at === -1) return 'An email address needs an @ — for example, name@example.com.'

  const local = value.slice(0, at)
  const domain = value.slice(at + 1)

  if (local === '') return 'There is nothing before the @.'

  if (local.length > 64) return 'The part before the @ is too long.'

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

  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  if (tld.length < 2) return 'That domain ending does not look right.'
  if (!/^[A-Za-z]{2,}$/.test(tld)) {
    return 'The part after the final dot must be at least two letters — for example, "com" or "in".'
  }

  if (value.length > MAX_EMAIL_LENGTH) return 'That address is too long.'

  return null
}

export function isValidEmail(raw: string): boolean {
  return emailProblem(raw) === null
}