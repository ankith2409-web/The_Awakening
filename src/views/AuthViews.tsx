import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useAttendee } from '@/auth/contexts'
import { hasErrors, VALIDATORS, validate, type FieldErrors } from '@/auth/validation'
import { Button } from '@/components/Button'
import { Checkbox, Field, PasswordField } from '@/components/Field'
import { Alert, SlideNavLink } from '@/components/Typography'
import { AuthShell } from '@/components/AuthShell'
import { PasswordHelp } from '@/components/PasswordHelp'
import { EventMark } from '@/components/EventMark'
import { isMockApi, portalApi } from '@/api'

/** Sign-in identifies an existing attendee by name + phone + password. */
type LoginFields = 'name' | 'phone' | 'password'

const LOGIN_INITIAL: Record<LoginFields, string> = {
  name: '',
  phone: '',
  password: '',
}

/**
 * Attendee sign-in: name + phone + password.
 *
 * Validation runs on blur and submit, never per keystroke ΓÇö flagging an
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
    registration gets replayed into this page's `tel-national` field ΓÇö the
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
      a half-typed "98765" when the attendee clicked away and came back ΓÇö
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
      React is concerned ΓÇö it sees no change and never rewrites the node, leaving
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
      title="Log in"
      description="Enter the name and mobile number you registered with. Your entry pass is issued the moment you log in."
      showSiteFooter
      footer={
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            First time here?
          </p>
          <SlideNavLink to="/register" className="border-b-2 border-swiss-ink pb-1">
            Register ΓåÆ
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
          label="Keep me logged in on this device"
          name="remember"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />

        <Button type="submit" variant="primary" size="lg" block loading={submitting}>
          {submitting ? 'Authenticating' : 'Log in'}
        </Button>

        {/*
          There is no self-service password reset, and this is where that is
          explained. It used to be one, and it was unverified ΓÇö no OTP, no email,
          no security question ΓÇö so knowing a phone number was enough to take over
          that account and walk in with the attendee's pass. Recovery is now by
          email to the organiser, who sets a new one by hand.

          Rendered after the submit button, not above the form: someone who
          reaches this has already tried to sign in and failed, so it belongs at
          the end of the thing they just tried. Its own component, because a
          locked-out path should not read as part of the sign-up flow.
        */}
        <PasswordHelp />

        {isMockApi ? (
          <p className="border-2 border-swiss-ink/20 bg-swiss-muted p-4 text-2xs font-medium leading-relaxed text-content-muted">
            <span className="font-bold uppercase tracking-[0.2em] text-swiss-ink">
              Demo
            </span>{' '}
            ΓÇö <span className="font-mono">Demo Attendee</span> /{' '}
            <span className="font-mono">9876543210</span> /{' '}
            <span className="font-mono">grid2026</span>
          </p>
        ) : null}
      </form>
    </AuthShell>
  )
}

/**
 * Where the attendee is in signing up.
 *
 * Four states rather than one form, because the thing that happens at the end —
 * being handed a password and asked to prove they read it — cannot be a field in the
 * form that came before it. It is the consequence of submitting, and it has to be the
 * next thing on the screen.
 *
 *   details  name, phone, SEN. Then the portal issues a password.
 *   reveal   the password, shown once. Read it back into two boxes.
 *   choose   asked whether they want a different password. Their call either way.
 *   change   the replacement form, if they said yes.
 *   done     signed in; on to the pass.
 *
 * `reveal` is its own screen, and `choose` is separate from `change`, so that the
 * password is displayed with nothing else competing for attention, and so somebody
 * happy with it can walk straight past the question.
 */
type RegisterStep = 'details' | 'reveal' | 'choose' | 'change' | 'done'

/** Registration collects the identity fields, and nothing else. */
type RegisterFields = 'name' | 'phone' | 'sen'

const REGISTER_INITIAL: Record<RegisterFields, string> = {
  name: '',
  phone: '',
  sen: '',
}

/**
 * Registration.
 *
 * The attendee does not choose a password. The portal generates one and hands it
 * over, and the attendee reads it back before they are let through.
 *
 * Why this replaced "choose your own password":
 *
 * The old form asked for a password and then made them type it twice, on a phone, at
 * a desk, in a queue. A single mistyped character locked them out of their own pass,
 * with no self-service recovery — the recovery path is an organiser at a desk, which
 * means queueing again. Generated-and-read-back removes the typing from the critical
 * path: there is nothing to mistype, because the attendee never chose it.
 *
 * Why the read-back is checked twice, in two different ways:
 *
 * Requiring the two boxes to match catches a typo in one of them. It cannot catch a
 * typo in BOTH — somebody who misreads the generated password and then faithfully
 * types the same wrong thing twice passes the client check and cannot log in later.
 * So the second check goes to the server and compares against the stored hash, while
 * the password is still on their screen.
 *
 * And why the change is offered afterwards rather than instead: some people would
 * rather have a password nobody else has ever read aloud. Both are fine; the portal
 * should not decide.
 */
export function RegisterView() {
  const { register, completeRegistration, error, clearError, event: eventInfo } =
    useAttendee()

  /*
    What the server will allow, read from the public event rather than discovered by
    submitting — and kept live by the event poll, so an organiser closing registration
    reaches an open form without anybody reloading.

    `closed` is not a state where the form should merely warn: there is nothing the
    visitor can do about it, so the form goes away and is replaced by the reason and
    who to contact. Leaving three live fields in front of somebody who is guaranteed
    to be refused is what makes a portal look broken.

    `restricted` is different — the visitor may well be on the list, so the form stays
    and simply says what the SEN is being checked against. Hiding it would lock out
    listed students as well as everyone else.
  */
  const mode = eventInfo?.registrationMode ?? 'open'

  const [step, setStep] = useState<RegisterStep>('details')
  const [values, setValues] =
    useState<Record<RegisterFields, string>>(REGISTER_INITIAL)
  const [touched, setTouched] = useState<Partial<Record<RegisterFields, boolean>>>({})
  const [errors, setErrors] = useState<FieldErrors<RegisterFields>>({})
  const [submitting, setSubmitting] = useState(false)

  /* -- the issued password, and the read-back --------------------------- */

  const [issued, setIssued] = useState<string | null>(null)
  const [typed, setTyped] = useState({ first: '', second: '' })
  const [typedTouched, setTypedTouched] = useState(false)
  const [readBackProblem, setReadBackProblem] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)

  /* -- the optional change ----------------------------------------------- */

  const [replacement, setReplacement] = useState({ first: '', second: '' })
  const [replacementTouched, setReplacementTouched] = useState(false)
  const [changeProblem, setChangeProblem] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)

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
    })
    setErrors(found)
    return found
  }, [values])

  useEffect(() => {
    clearError()
  }, [clearError])

  /*
    Registration closing while somebody is part-way through the form.

    The closed panel is shown when there is nothing to lose, and demoted to a warning
    once they have typed something. Yanking the fields out from under somebody
    mid-form destroys their input to no purpose — they can finish and be told, and the
    server refuses them anyway. Being kicked out of a form you are filling in is
    exactly the "this thing is broken" feeling the closed panel exists to avoid.
  */
  const hasTypedSomething =
    values.name !== '' || values.phone !== '' || values.sen !== ''
  const registrationClosed = mode === 'closed' && step === 'details'
  const closedButInProgress = mode === 'closed' && step === 'details' && hasTypedSomething

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const found = runValidation()
    setTouched({ name: true, phone: true, sen: true })

    if (hasErrors(found)) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }

    setSubmitting(true)
    try {
      const result = await register(values.name, values.phone, values.sen)
      setIssued(result.generatedPassword)
      setStep('reveal')
    } catch {
      // Rendered through the provider's error state.
    } finally {
      setSubmitting(false)
    }
  }

  /*
    The read-back.

    Client-side first — the two boxes must match each other — because that is free,
    instant, and catches the common case without a round trip. Then the server, which
    is the only check that can notice somebody typed the same misread password twice.
  */
  const typedMismatch = typed.first !== '' && typed.first !== typed.second
  const typedTooShort = typed.first !== '' && typed.first.length < 4

  async function confirmReadBack(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (verifying || issued === null) return

    setTypedTouched(true)
    setReadBackProblem(null)

    if (typed.first !== typed.second) return
    if (typedTooShort) return

    setVerifying(true)
    try {
      const result = await portalApi.verifyAttendeePassword(typed.first)
      if (result.matches) {
        setStep('choose')
      } else {
        setReadBackProblem(
          'That is not the password shown above. Check it character by character — the groups are separated by dashes.',
        )
      }
    } catch {
      setReadBackProblem('Could not check that just now. Try again in a moment.')
    } finally {
      setVerifying(false)
    }
  }

  const replacementProblems = {
    first: VALIDATORS.password(replacement.first),
    second:
      replacement.first === replacement.second
        ? null
        : 'These do not match.',
  }

  async function submitChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (changing || issued === null) return

    setReplacementTouched(true)
    setChangeProblem(null)

    if (replacementProblems.first !== null || replacementProblems.second !== null) {
      return
    }

    setChanging(true)
    try {
      await portalApi.changeOwnPassword({
        currentPassword: issued,
        newPassword: replacement.first,
      })
      setReplacement({ first: '', second: '' })
      setStep('done')
      completeRegistration()
    } catch (cause) {
      setChangeProblem(
        cause instanceof Error ? cause.message : 'Could not change that password.',
      )
    } finally {
      setChanging(false)
    }
  }

  /* -- the four screens ------------------------------------------------- */

  const detailsScreen = (
    <>
      {closedButInProgress ? (
        <div className="border-l-4 border-swiss-accent-text bg-swiss-muted p-4">
          <p className="text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
            Registration has just been closed
          </p>
          <p className="mt-2 text-2xs font-medium leading-relaxed text-content-muted">
            Your details are kept on this page — finish and try, but it may be
            refused.
          </p>
        </div>
      ) : null}

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

        <Button type="submit" variant="primary" size="lg" block loading={submitting}>
          {submitting ? 'Creating your pass' : 'Get my pass'}
        </Button>

        <p className="text-2xs font-medium leading-relaxed text-content-muted">
          We will give you a password on the next screen. You will need it to log in
          on the day.
        </p>
      </form>
    </>
  )

  const revealScreen = (
    <form
      id="auth-form"
      noValidate
      onSubmit={confirmReadBack}
      className="flex flex-col gap-6"
    >
      <div className="border-2 border-swiss-ink bg-swiss-muted p-6">
        <p className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
          Your password
        </p>

        {/*
          Large, monospaced and alone on its own line, because it is about to be read
          out loud and typed back. A sentence-sized credential inside a paragraph is
          the one thing guaranteed to be mis-transcribed.

          It is shown in full, not behind a reveal toggle. The person looking at this
          screen is the person who owns the password, on their own phone; hiding it
          from them protects nothing and adds a tap between them and the only copy
          that will ever exist.
        */}
        <p className="mt-4 select-all break-all font-mono text-4xl font-black leading-tight tracking-tight text-swiss-ink">
          {issued}
        </p>

        <p className="mt-4 text-2xs font-medium leading-relaxed text-content-muted">
          This is the only time it will be shown. Write it down or take a screenshot —
          if you lose it, an organiser at the desk has to set you a new one.
        </p>
      </div>

      {readBackProblem !== null ? (
        <Alert>{readBackProblem}</Alert>
      ) : null}

      <PasswordField
        label="Type your password"
        name="password-readback"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        value={typed.first}
        hint="Exactly as shown, including the dashes."
        error={
          typedTouched && typedMismatch
            ? 'These do not match yet.'
            : typedTouched && typedTooShort
              ? 'That looks too short — use the whole password.'
              : undefined
        }
        onChange={(event) => {
          setTyped((current) => ({ ...current, first: event.target.value }))
          setReadBackProblem(null)
        }}
      />

      <PasswordField
        label="Type it again"
        name="password-readback-confirm"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        value={typed.second}
        error={typedTouched && typedMismatch ? 'These do not match.' : undefined}
        onChange={(event) => {
          setTyped((current) => ({ ...current, second: event.target.value }))
          setReadBackProblem(null)
        }}
      />

      <Button type="submit" variant="primary" size="lg" block loading={verifying}>
        {verifying ? 'Checking' : 'That is my password'}
      </Button>
    </form>
  )

  const changeScreen = (
    <div className="flex flex-col gap-6">
      {/*
        Asked, not imposed. Two buttons and no default: somebody happy with the
        password they were given should be able to walk straight past this.
      */}
      <div className="border-2 border-swiss-ink bg-swiss-muted p-6">
        <p className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
          Password confirmed
        </p>
        <p className="mt-3 text-sm leading-relaxed text-content-muted">
          Would you like to change it to one of your own?
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          variant="primary"
          size="lg"
          block
          onClick={() => {
            setStep('done')
            completeRegistration()
          }}
        >
          Keep it
        </Button>
        <Button variant="secondary" size="lg" block onClick={() => setStep('change')}>
          Change it
        </Button>
      </div>
    </div>
  )

  const replacementScreen = (
    <form
      id="auth-form"
      noValidate
      onSubmit={submitChange}
      className="flex flex-col gap-6"
    >
      {changeProblem !== null ? <Alert>{changeProblem}</Alert> : null}

      <PasswordField
        label="New password"
        name="password-new"
        autoComplete="new-password"
        value={replacement.first}
        hint="Minimum 8 characters, with one letter and one number."
        error={replacementTouched ? (replacementProblems.first ?? undefined) : undefined}
        onChange={(event) =>
          setReplacement((current) => ({ ...current, first: event.target.value }))
        }
      />

      <PasswordField
        label="Type it again"
        name="password-new-confirm"
        autoComplete="new-password"
        value={replacement.second}
        error={
          replacementTouched ? (replacementProblems.second ?? undefined) : undefined
        }
        onChange={(event) => {
          setReplacement((current) => ({ ...current, second: event.target.value }))
          setChangeProblem(null)
        }}
        onBlur={() => setReplacementTouched(true)}
      />

      <Button type="submit" variant="primary" size="lg" block loading={changing}>
        {changing ? 'Saving' : 'Save and continue'}
      </Button>

      <button
        type="button"
        className="cursor-pointer text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink underline decoration-swiss-ink/30 underline-offset-4"
        onClick={() => {
          setStep('done')
          completeRegistration()
        }}
      >
        Keep the generated one
      </button>
    </form>
  )

  /*
    `step === 'change'` is the CHANGE FORM, and `step === 'choose'` is the question
    that leads to it. They are separate screens on purpose: somebody happy with the
    password they were handed should be able to walk past this in one tap, and the
    surest way to stop them doing that is to put a form in front of them first.
  */
  const TITLES: Record<RegisterStep, { eyebrow: string; title: string; description: string }> = {
    details: {
      eyebrow: '02. Register',
      title: 'Register',
      description: 'Three fields and you are in. Your name and mobile number identify you at the door — the QR pass is generated instantly.',
    },
    reveal: {
      eyebrow: '02. Your password',
      title: 'Save it',
      description: 'Type it back exactly as shown to confirm you have it.',
    },
    choose: {
      eyebrow: '02. Your password',
      title: 'Keep it?',
      description: 'Your password works as it is. You can change it if you would rather.',
    },
    change: {
      eyebrow: '02. Your password',
      title: 'Change it',
      description: 'Only if you would rather. The one you have already works.',
    },
    done: {
      eyebrow: '02. Register',
      title: 'You are in',
      description: 'Your pass is ready.',
    },
  }

  const heading = TITLES[step]

  /*
    When registration closes while this screen is up, the description is replaced too.

    The poll can close registration underneath somebody who has the form open, and
    "Three fields and you are in" above a panel that says registration is closed is a
    small lie that makes the whole page read as broken rather than as deliberately
    shut. `registrationClosed` only ever turns this on for the details step, so the
    reveal and change screens are never affected.
  */
  const shown = registrationClosed
    ? {
        eyebrow: '02. Register',
        title: 'Register',
        description:
          'Registration for this event is not open. If you already have a pass, log in and it will be waiting.',
      }
    : heading

  return (
    <AuthShell
      logo={<EventMark />}
      eyebrow={shown.eyebrow}
      title={shown.title}
      description={shown.description}
      showSiteFooter
      footer={
        /*
          Only on the first step, and never when registration is closed — in both
          cases the screen itself already says what to do, and a second "Log in"
          below it is just the same link twice.
        */
        step !== 'details' || registrationClosed ? undefined : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
              Already registered?
            </p>
            <SlideNavLink to="/login" className="border-b-2 border-swiss-ink pb-1">
              Log in →
            </SlideNavLink>
          </div>
        )
      }
    >
      {/*
        Registration is closed.

        The fields are not merely disabled — they are gone. A disabled form reads as
        "temporarily broken, try again in a moment", which is the opposite of what is
        true, and it invites somebody to reload a page that will never work.

        Log in is still offered, because closing registration to new people is not the
        same as locking out the ones already registered.
      */}
      {registrationClosed && !closedButInProgress ? (
        <div className="flex flex-col gap-6">
          <div className="border-2 border-swiss-ink bg-swiss-muted p-6">
            <p className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
              Registration is closed
            </p>
            <p className="mt-3 text-sm leading-relaxed text-content-muted">
              New registrations are not being taken for this event. If you already
              registered, you can still log in and show your pass at the door.
            </p>
          </div>

          <SlideNavLink
            to="/login"
            className="inline-flex min-h-12 items-center justify-center border-2 border-swiss-ink bg-swiss-ink px-6 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-paper"
          >
            Log in →
          </SlideNavLink>
        </div>
      ) : null}

      {step === 'details' && !registrationClosed ? (
        <>
          {mode === 'restricted' ? (
            <div className="border-l-4 border-swiss-ink bg-swiss-muted p-4">
              <p className="text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
                Guest list only — your SEN is checked against it
              </p>
            </div>
          ) : null}
          {detailsScreen}
        </>
      ) : null}

      {step === 'reveal' ? revealScreen : null}
      {step === 'choose' ? changeScreen : null}
      {step === 'change' ? replacementScreen : null}
      {step === 'done' ? (
        <div className="border-2 border-swiss-ink bg-swiss-muted p-6">
          <p className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
            Done
          </p>
          <p className="mt-3 text-sm leading-relaxed text-content-muted">
            Your QR pass is ready. It will be waiting on the next screen.
          </p>
        </div>
      ) : null}
    </AuthShell>
  )
}
