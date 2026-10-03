import { useEffect, useState, type FormEvent } from 'react'
import { useAdmin } from '@/auth/contexts'
import { hasErrors, VALIDATORS, validate, type FieldErrors } from '@/auth/validation'
import { Button } from '@/components/Button'
import { Field, PasswordField } from '@/components/Field'
import { Alert, SlideNavLink } from '@/components/Typography'
import { AuthShell } from '@/components/AuthShell'
import { EventMark } from '@/components/EventMark'
import { isMockApi } from '@/api'

type Fields = 'username' | 'password'

const INITIAL: Record<Fields, string> = { username: '', password: '' }

/**
 * Admin sign-in — a deliberately separate door from the attendee one.
 *
 * No link to it from the attendee flow: staff should reach it by URL, and the
 * two credentials never mix.
 */
export function AdminLoginView() {
  const { login, error, clearError } = useAdmin()

  const [values, setValues] = useState<Record<Fields, string>>(INITIAL)
  const [touched, setTouched] = useState<Partial<Record<Fields, boolean>>>({})
  const [errors, setErrors] = useState<FieldErrors<Fields>>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    clearError()
  }, [clearError])

  function setValue(field: Fields, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }))
  }

  function runValidation() {
    const found = validate(values, {
      username: VALIDATORS.username,
      // An empty password is the only client-side check here; complexity is
      // enforced at registration, never retroactively on sign-in.
      password: (value) => (value === '' ? 'Password is required.' : null),
    })
    setErrors(found)
    return found
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const found = runValidation()
    setTouched({ username: true, password: true })

    if (hasErrors(found)) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }

    setSubmitting(true)
    try {
      await login(values.username, values.password)
    } catch {
      // Rendered through the provider's error state.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      logo={<EventMark />}
      eyebrow="05. Operations"
      title="Admin"
      description="Restricted area. Staff credentials are issued separately from attendee registration and are not transferable."
      footer={
        <SlideNavLink to="/login" className="border-b-2 border-swiss-ink pb-1">
          ← Attendee sign in
        </SlideNavLink>
      }
    >
      <form
        id="auth-form"
        noValidate
        onSubmit={handleSubmit}
        className="flex flex-col gap-6"
      >
        {error ? <Alert>{error.message}</Alert> : null}

        <Field
          label="Username"
          name="username"
          autoComplete="username"
          value={values.username}
          error={touched.username ? errors.username : undefined}
          onChange={(event) => setValue('username', event.target.value)}
          onBlur={() => {
            setTouched((current) => ({ ...current, username: true }))
            runValidation()
          }}
        />

        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          value={values.password}
          error={touched.password ? errors.password : undefined}
          onChange={(event) => setValue('password', event.target.value)}
          onBlur={() => {
            setTouched((current) => ({ ...current, password: true }))
            runValidation()
          }}
        />

        <Button type="submit" variant="primary" size="lg" block loading={submitting}>
          {submitting ? 'Verifying' : 'Enter admin portal'}
        </Button>

        {isMockApi ? (
          <p className="border-2 border-swiss-ink/20 bg-swiss-muted p-4 text-2xs font-medium leading-relaxed text-content-muted">
            <span className="font-bold uppercase tracking-[0.2em] text-swiss-ink">
              Demo
            </span>{' '}
            — <span className="font-mono">admin</span> /{' '}
            <span className="font-mono">ops2026</span>
          </p>
        ) : null}
      </form>
    </AuthShell>
  )
}
