import { isValidSen, normalisePhone, phoneProblem } from '@/domain/phone'
import { nameProblem } from '@/domain/name'

/**
 * Client-side validation.
 *
 * Pure functions mirroring the server's rules. Client validation exists for
 * fast feedback only — the API re-checks everything.
 */

export type FieldErrors<T extends string> = Partial<Record<T, string>>

export const VALIDATORS = {
  name(value: string): string | null {
    // One rule, in one place. It used to be inlined here and there was no server
    // counterpart at all, so the browser was the only thing enforcing it — and the
    // API happily accepted an emoji name.
    return nameProblem(value)
  },

  phone(value: string): string | null {
    // `phoneProblem` names the actual fault rather than always blaming length.
    // Someone who types "0545654587" has entered ten digits already, so telling
    // them the digit count is wrong sends them hunting for a problem they do not
    // have — the real fault is the leading zero.
    return phoneProblem(value)
  },

  password(value: string): string | null {
    if (value === '') return 'Password is required.'
    if (value.length < 8) return 'Use at least 8 characters.'
    if (!/[a-zA-Z]/.test(value)) return 'Include at least one letter.'
    if (!/\d/.test(value)) return 'Include at least one number.'
    return null
  },

  /**
   * SEN. Validated with the same normaliser the API and the gate scanner use,
   * so the three can never disagree about what counts as a valid code.
   */
  sen(value: string): string | null {
    if (value.trim() === '') return 'SEN is required.'
    if (!isValidSen(value)) return 'Enter a valid SEN, e.g. A866175000012.'
    return null
  },

  username(value: string): string | null {
    const trimmed = value.trim()
    if (trimmed === '') return 'Username is required.'
    if (trimmed.length < 3) return 'Use at least 3 characters.'
    return null
  },
}

/**
 * Rules keyed by field, so each form declares its policy declaratively.
 *
 * A rule receives its own value, then the whole record — the second argument
 * lets cross-field rules coexist with simple ones in a uniform list.
 */
export type Rule<T extends string> = (
  value: string,
  all: Readonly<Record<T, string>>,
) => string | null

export function validate<T extends string>(
  values: Record<T, string>,
  rules: Readonly<Record<T, Rule<T>>>,
): FieldErrors<T> {
  const errors: FieldErrors<T> = {}

  for (const key of Object.keys(rules) as T[]) {
    const message = rules[key](values[key], values)
    if (message !== null) errors[key] = message
  }

  return errors
}

export function hasErrors<T extends string>(errors: FieldErrors<T>): boolean {
  return Object.keys(errors).length > 0
}

export { normalisePhone }