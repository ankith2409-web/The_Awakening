import { useEffect, useState, type FormEvent } from 'react'
import { portalApi } from '@/api'
import { PortalError, type PasswordResetResult } from '@/domain/types'
import { hasErrors, VALIDATORS, validate, type FieldErrors } from '@/auth/validation'
import { Button } from '@/components/Button'
import { Field, PasswordField } from '@/components/Field'
import { Alert, SlideNavLink } from '@/components/Typography'
import { AuthShell } from '@/components/AuthShell'
import { EventMark } from '@/components/EventMark'

type Fields = 'phone' | 'password'

const INITIAL: Record<Fields, string> = { phone: '', password: '' }

/**
 * Password reset for attendees.
 *
 * UNVERIFIED BY DESIGN. There is no OTP, no email and no security question —
 * a phone number alone is enough to set a new password. The organiser asked for
 * this explicitly; it is called out in the README as an account-takeover path,
 * and the server compensates with rate limiting plus a response that is
 * identical whether or not the number is registered.
 *
 * Two consequences shape this screen:
 *
 *   1. We never confirm or deny that a number exists. The success state says
 *      "if that number is registered" and leaves the attendee to try signing in.
 *   2. There is no masked-number round trip. Showing `*****535` and asking for
 *      the full number back proves nothing — the attendee already typed it — and
 *      leaks the last three digits.
 *
 * Attendee-only. Staff credentials are not resettable over the public API.
 */
export function ForgotPasswordView() {
  const [values, setValues] = useState<Record<Fields, string>>(INITIAL)
  const [touched, setTouched] = useState<Partial<Record<Fields, boolean>>>({})
  const [errors, setErrors] = useState<FieldErrors<Fields>>({})
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [result, setResult] = useState<PasswordResetResult | null>(null)

  useEffect(() => {
    setFailure(null)
  }, [])

  function setValue(field: Fields, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }))
  }

  function runValidation() {
    const found = validate(values, {
      phone: VALIDATORS.phone,
      password: VALIDATORS.password,
    })
    setErrors(found)
    return found
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const found = runValidation()
    setTouched({ phone: true, password: true })

    if (hasErrors(found)) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }

    setSubmitting(true)
    setFailure(null)
    try {
      setResult(await portalApi.resetAttendeePassword(values))
      // Clear the new password from memory the moment it is no longer needed.
      setValues((current) => ({ ...current, password: '' }))
    } catch (cause) {
      setFailure(
        cause instanceof PortalError ? cause.message : 'Something went wrong. Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      logo={<EventMark />}
      eyebrow="01. Access"
      title="Reset"
      description="Enter the mobile number you registered with and choose a new password."
      footer={
        <SlideNavLink to="/login" className="border-b-2 border-swiss-ink pb-1">
          ← Back to sign in
        </SlideNavLink>
      }
    >
      {result ? (
        /*
          Success renders as a neutral panel, not an `Alert` — Alert is reserved
          for the accent colour's one job, signalling failure, so reusing it
          would make "done" look like "broken".

          No second call to action here: the footer already carries
          "← Back to sign in", and a bold button next to it duplicated the way
          out. One route back, not two.
        */
        <div className="flex items-start gap-4 border-2 border-swiss-ink bg-swiss-muted p-4">
          <span aria-hidden="true" className="mt-1 size-3 shrink-0 bg-swiss-ink" />
          <p
            role="status"
            className="text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
          >
            {result.message}
          </p>
        </div>
      ) : (
        <form
          id="auth-form"
          noValidate
          onSubmit={handleSubmit}
          className="flex flex-col gap-6"
        >
          {failure ? <Alert>{failure}</Alert> : null}

          <Field
            label="Phone Number"
            name="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            hint="The number you registered with."
            value={values.phone}
            error={touched.phone ? errors.phone : undefined}
            onChange={(event) => setValue('phone', event.target.value)}
            onBlur={() => {
              setTouched((current) => ({ ...current, phone: true }))
              runValidation()
            }}
          />

          <PasswordField
            label="New Password"
            name="password"
            autoComplete="new-password"
            hint="Minimum 8 characters, with one letter and one number."
            value={values.password}
            error={touched.password ? errors.password : undefined}
            onChange={(event) => setValue('password', event.target.value)}
            onBlur={() => {
              setTouched((current) => ({ ...current, password: true }))
              runValidation()
            }}
          />

          <Button type="submit" variant="primary" size="lg" block loading={submitting}>
            {submitting ? 'Updating' : 'Set new password'}
          </Button>
        </form>
      )}
    </AuthShell>
  )
}
