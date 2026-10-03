import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useAttendee } from '@/auth/contexts'
import { hasErrors, VALIDATORS, validate, type FieldErrors } from '@/auth/validation'
import { Button } from '@/components/Button'
import { Checkbox, Field, PasswordField } from '@/components/Field'
import { Alert, SlideNavLink } from '@/components/Typography'
import { AuthShell } from '@/components/AuthShell'
import { EventMark } from '@/components/EventMark'
import { isMockApi } from '@/api'

/** Sign-in identifies an existing attendee by name + phone + password. */
type LoginFields = 'name' | 'phone' | 'password'

/** Registration additionally collects the SEN their barcode will carry. */
type RegisterFields = 'name' | 'phone' | 'sen' | 'password'

const LOGIN_INITIAL: Record<LoginFields, string> = {
  name: '',
  phone: '',
  password: '',
}

const REGISTER_INITIAL: Record<RegisterFields, string> = {
  name: '',
  phone: '',
  sen: '',
  password: '',
}

/**
 * Attendee sign-in: name + phone + password.
 *
 * Validation runs on blur and submit, never per keystroke — flagging an
 * incomplete phone number while the user is still typing it is hostile.
 */
export function LoginView() {
  const { login, error, clearError } = useAttendee()

  const [values, setValues] = useState<Record<LoginFields, string>>(LOGIN_INITIAL)
  const [touched, setTouched] = useState<Partial<Record<LoginFields, boolean>>>({})
  const [errors, setErrors] = useState<FieldErrors<LoginFields>>({})
  const [remember, setRemember] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  /*
    Clears a browser-autofilled SEN out of the phone box.

    Chrome stores values against fields it recognises by `autocomplete`, `name`
    and position. "sen" is not a token it knows, so the value captured during
    registration gets replayed into this page's `tel-national` field — the
    symptom being a code like A866175000012 sitting in the phone number box.

    Fixing it at source (the register field) reduces how often Chrome captures
    it, but cannot prevent it. Two checks here instead:

      - on mount, for autofill that landed before React hydrated
      - on focus, for autofill that lands afterwards

    The focus check is the one that actually matters. Chrome autofill fires no
    change event and its timing relative to hydration is unpredictable, so a
    mount-only check loses that race often enough to look random. Focusing the
    field is the moment the attendee is about to type, so discarding a value
    that could not be a phone number costs nothing and is never in the way.
  */
  const phoneRef = useRef<HTMLInputElement>(null)

  /** Reads the DOM value, because autofill bypasses React state entirely. */
  const clearUnusablePhone = useCallback(() => {
    const input = phoneRef.current
    if (!input) return

    const dom = input.value.trim()
    /*
      Clear only what could never be a phone number: a value containing letters.

      An earlier version tested `isValidIndianMobile` instead, which also wiped
      a half-typed "98765" when the attendee clicked away and came back —
      destroying real input to fix a cosmetic problem. Letters are the precise
      signal: A866175000012 and 22CS1RE0123 both contain them and are always wrong
      in this field, while 9876543210, "98765 43210" and a partial "98765" never
      do.
    */
    if (!/[a-z]/i.test(dom)) return

    /*
      Clear the node through the native setter, not just React state.

      Chrome autofill writes straight to the DOM, so React's value tracker still
      believes the field holds ''. Setting state to '' is then a no-op as far as
      React is concerned — it sees no change and never rewrites the node, leaving
      the SEN sitting in the box. Going through the native setter updates the
      tracker too, so the two agree and the field genuinely empties.
    */
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    setter?.call(input, '')

    setValues((current) => ({ ...current, phone: '' }))
  }, [])

  useEffect(() => {
    clearUnusablePhone()
  }, [clearUnusablePhone])

  const setValue = useCallback(
    (field: LoginFields, value: string) => {
      setValues((current) => ({ ...current, [field]: value }))
      if (errors[field]) {
        setErrors((current) => ({ ...current, [field]: undefined }))
      }
    },
    [errors],
  )

  const runValidation = useCallback(() => {
    const found = validate(values, {
      name: VALIDATORS.name,
      phone: VALIDATORS.phone,
      password: VALIDATORS.password,
    })
    setErrors(found)
    return found
  }, [values])

  useEffect(() => {
    clearError()
  }, [clearError])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const found = runValidation()
    setTouched({ name: true, phone: true, password: true })

    if (hasErrors(found)) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }

    setSubmitting(true)
    try {
      await login(values.name, values.phone, values.password, remember)
    } catch {
      // Rendered through the provider's error state.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      logo={<EventMark />}
      eyebrow="01. Access"
      title="Log In"
      description="Enter the name and mobile number you registered with. Your entry pass is issued the moment you log in."
      footer={
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            First time here?
          </p>
          <SlideNavLink to="/register" className="border-b-2 border-swiss-ink pb-1">
            Register →
          </SlideNavLink>
        </div>
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
          label="Full Name"
          name="name"
          autoComplete="name"
          value={values.name}
          error={touched.name ? errors.name : undefined}
          onChange={(event) => setValue('name', event.target.value)}
          onBlur={() => {
            setTouched((current) => ({ ...current, name: true }))
            runValidation()
          }}
        />

        <Field
          label="Phone Number"
          name="phone"
          ref={phoneRef}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          hint="Ten digits, no country code."
          value={values.phone}
          error={touched.phone ? errors.phone : undefined}
          onChange={(event) => setValue('phone', event.target.value)}
          onFocus={clearUnusablePhone}
          onBlur={() => {
            setTouched((current) => ({ ...current, phone: true }))
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

        <Checkbox
          label="Keep me signed in on this device"
          name="remember"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />

        <Button type="submit" variant="primary" size="lg" block loading={submitting}>
          {submitting ? 'Authenticating' : 'Log in'}
        </Button>

        <SlideNavLink
          to="/forgot-password"
          className="self-start border-b-2 border-swiss-ink pb-1"
        >
          Forgot password?
        </SlideNavLink>

        {isMockApi ? (
          <p className="border-2 border-swiss-ink/20 bg-swiss-muted p-4 text-2xs font-medium leading-relaxed text-content-muted">
            <span className="font-bold uppercase tracking-[0.2em] text-swiss-ink">
              Demo
            </span>{' '}
            — <span className="font-mono">Demo Attendee</span> /{' '}
            <span className="font-mono">9876543210</span> /{' '}
            <span className="font-mono">grid2026</span>
          </p>
        ) : null}
      </form>
    </AuthShell>
  )
}

/** Registration differs from login only by omitting "remember". */
export function RegisterView() {
  const { register, error, clearError } = useAttendee()

  const [values, setValues] =
    useState<Record<RegisterFields, string>>(REGISTER_INITIAL)
  const [touched, setTouched] = useState<Partial<Record<RegisterFields, boolean>>>({})
  const [errors, setErrors] = useState<FieldErrors<RegisterFields>>({})
  const [submitting, setSubmitting] = useState(false)

  const setValue = useCallback(
    (field: RegisterFields, value: string) => {
      setValues((current) => ({ ...current, [field]: value }))
      if (errors[field]) {
        setErrors((current) => ({ ...current, [field]: undefined }))
      }
    },
    [errors],
  )

  const runValidation = useCallback(() => {
    const found = validate(values, {
      name: VALIDATORS.name,
      phone: VALIDATORS.phone,
      sen: VALIDATORS.sen,
      password: VALIDATORS.password,
    })
    setErrors(found)
    return found
  }, [values])

  useEffect(() => {
    clearError()
  }, [clearError])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const found = runValidation()
    setTouched({ name: true, phone: true, sen: true, password: true })

    if (hasErrors(found)) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }

    setSubmitting(true)
    try {
      await register(values.name, values.phone, values.password, values.sen)
    } catch {
      // Rendered through the provider's error state.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      logo={<EventMark />}
      eyebrow="02. Register"
      title="Register"
      description="Three fields and you are in. Your name and mobile number identify you at the door — the QR pass is generated instantly."
      footer={
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            Already registered?
          </p>
          <SlideNavLink to="/login" className="border-b-2 border-swiss-ink pb-1">
            Log in →
          </SlideNavLink>
        </div>
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
          label="Full Name"
          name="name"
          autoComplete="name"
          value={values.name}
          error={touched.name ? errors.name : undefined}
          onChange={(event) => setValue('name', event.target.value)}
          onBlur={() => {
            setTouched((current) => ({ ...current, name: true }))
            runValidation()
          }}
        />

        <Field
          label="Phone Number"
          name="phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          hint="Ten digits, no country code."
          value={values.phone}
          error={touched.phone ? errors.phone : undefined}
          onChange={(event) => setValue('phone', event.target.value)}
          onBlur={() => {
            setTouched((current) => ({ ...current, phone: true }))
            runValidation()
          }}
        />

        <Field
          label="SEN"
          name="sen"
          /*
            `autocomplete="off"` alone does NOT stop this.

            Chrome largely ignores `off` on fields it believes are fillable, and
            `sen` is not a token it recognises — so it falls back to matching by
            name and position, and stores the value against a neighbouring
            `tel-national` field. The visible symptom was the SEN appearing in
            the PHONE box on the sign-in page, because that page has a phone
            field for it to land in.

            The `data-*` attributes are the opt-outs honoured by 1Password,
            LastPass and Bitwarden; `autoCorrect`/`autoCapitalize` stop mobile
            keyboards mangling a code. Together they stop the value being
            captured at source, which is the only place this can genuinely be
            fixed — scrubbing it back out of a sign-in field would mean fighting
            the browser on every load.
          */
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          hint="Printed on your barcode. This is how attendance is recorded."
          value={values.sen}
          error={touched.sen ? errors.sen : undefined}
          onChange={(event) => setValue('sen', event.target.value.toUpperCase())}
          onBlur={() => {
            setTouched((current) => ({ ...current, sen: true }))
            runValidation()
          }}
        />

        <PasswordField
          label="Password"
          name="password"
          autoComplete="new-password"
          value={values.password}
          hint="Minimum 8 characters, with one letter and one number."
          error={touched.password ? errors.password : undefined}
          onChange={(event) => setValue('password', event.target.value)}
          onBlur={() => {
            setTouched((current) => ({ ...current, password: true }))
            runValidation()
          }}
        />

        <Button type="submit" variant="primary" size="lg" block loading={submitting}>
          {submitting ? 'Registering' : 'Register'}
        </Button>
      </form>
    </AuthShell>
  )
}
