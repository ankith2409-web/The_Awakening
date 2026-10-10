import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useAttendee } from '@/auth/contexts'
import { hasErrors, VALIDATORS, validate, type FieldErrors } from '@/auth/validation'
import { Button } from '@/components/Button'
import { Checkbox, Field, PasswordField } from '@/components/Field'
import { Alert, SlideNavLink } from '@/components/Typography'
import { AuthShell } from '@/components/AuthShell'
import { Link } from 'react-router-dom'
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
 * Three states, and the middle one is the whole design:
 *
 *   details   name, phone, SEN. Then the portal issues a password.
 *   password  that password, shown once, WITH THE CHOICE ON THE SAME SCREEN —
 *             keep it, or type one of your own instead.
 *   done      signed in; on to the pass.
 *
 * This used to be five states, with the generated password on one screen, a read-back
 * on the next, a question on a third and the change form on a fourth. Four screens to
 * reach a pass, for a decision that is really one question with two answers.
 *
 * The read-back went first. Asking somebody to type a password twice, immediately
 * after handing it to them, was a way of catching a transcription error — and it caught
 * a lot of nothing. Nobody mistypes a password they have just been shown and have not
 * written down; what it actually did was put four screens between a student and their
 * pass, at a desk, in a queue. Losing it is recoverable: the desk sets a new one.
 *
 * So: one screen, the password on it, and the choice on it too. Somebody who wants
 * their own types it right there. Somebody who is happy presses one button and is
 * through.
 */
type RegisterStep = 'details' | 'password' | 'done'

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
 * The attendee does not choose a password to begin with — the portal generates one and
 * hands it over, because the old form asked for a password and then made them type it
 * twice on a phone at a desk, where a single mistyped character locked them out of
 * their own pass with no self-service recovery.
 *
 * They are offered the choice immediately, on the same screen: keep the generated one,
 * or type one of their own. That ordering is deliberate. Offering it first means
 * somebody who would rather have a password nobody else has ever read aloud is not
 * made to walk past a form to get it, and somebody who is indifferent is one tap from
 * done.
 */
export function RegisterView() {
  /*
    `eventInfo`, not `event`.

    Every field handler below is `(event) => setValue(...)`, and shadowing the
    context's `event` with the DOM event in several places is exactly the kind of thing
    that reads correctly right up until somebody needs the event record.
  */
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
  */
  const mode = eventInfo?.registrationMode ?? 'open'

  const [step, setStep] = useState<RegisterStep>('details')
  const [values, setValues] =
    useState<Record<RegisterFields, string>>(REGISTER_INITIAL)
  const [touched, setTouched] = useState<Partial<Record<RegisterFields, boolean>>>({})
  const [errors, setErrors] = useState<FieldErrors<RegisterFields>>({})
  const [submitting, setSubmitting] = useState(false)

  /* -- the issued password, and the optional replacement ------------------ */

  const [issued, setIssued] = useState<string | null>(null)
  /** Whether they have chosen to type their own, on this same screen. */
  const [useOwn, setUseOwn] = useState(false)
  const [own, setOwn] = useState({ first: '', second: '' })
  const [ownTouched, setOwnTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ownProblem, setOwnProblem] = useState<string | null>(null)

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
    once they have typed something. Yanking the fields out from under somebody mid-form
    destroys their input to no purpose — they can finish and be told, and the server
    refuses them anyway. Being kicked out of a form you are filling in is exactly the
    "this thing is broken" feeling the closed panel exists to avoid.
  */
  const hasTypedSomething =
    values.name !== '' || values.phone !== '' || values.sen !== ''
  const registrationClosed = mode === 'closed' && step === 'details'
  const closedButInProgress =
    mode === 'closed' && step === 'details' && hasTypedSomething

  function finish() {
    setStep('done')
    completeRegistration()
  }

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
      setStep('password')
    } catch {
      // Rendered through the provider's error state.
    } finally {
      setSubmitting(false)
    }
  }

  /*
    Saving their own password instead.

    `currentPassword` is the generated one, which the server checks. That is not a
    formality even though they can see it on this very screen: the check establishes
    that the session belongs to whoever just registered, and an attacker holding a
    stolen session could otherwise skip straight past it.
  */
  const ownProblems = {
    first: VALIDATORS.password(own.first),
    second: own.first === own.second ? null : 'These do not match.',
  }

  async function submitOwn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || issued === null) return

    setOwnTouched(true)
    setOwnProblem(null)

    if (ownProblems.first !== null || ownProblems.second !== null) return

    setSaving(true)
    try {
      await portalApi.changeOwnPassword({
        currentPassword: issued,
        newPassword: own.first,
      })
      setOwn({ first: '', second: '' })
      finish()
    } catch (cause) {
      setOwnProblem(
        cause instanceof Error ? cause.message : 'Could not change that password.',
      )
    } finally {
      setSaving(false)
    }
  }

  /* -- the screens -------------------------------------------------------- */

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
          on the day — and you can change it there if you would rather.
        </p>
      </form>
    </>
  )

  /*
    The password, and the choice, on one screen.

    The password is shown large, monospaced and alone, because it is about to be
    written down or read aloud. It is not behind a reveal toggle: the person looking
    at this screen is the person who owns the password, on their own phone, and hiding
    it from them protects nothing while adding a tap between them and the only copy
    that will ever exist.
  */
  const passwordScreen = (
    <div className="flex flex-col gap-6">
      <div className="border-2 border-swiss-ink bg-swiss-muted p-6">
        <p className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
          Your password
        </p>

        <p className="mt-4 select-all break-all font-mono text-[clamp(1.5rem,7vw,2.25rem)] font-black leading-tight tracking-tight text-swiss-ink">
          {issued}
        </p>

        <p className="mt-4 text-2xs font-medium leading-relaxed text-content-muted">
          This is the only time it will be shown. Write it down or take a screenshot —
          if you lose it, an organiser at the desk has to set you a new one.
        </p>
      </div>

      {/* -- they want the generated one ---------------------------------- */}
      {!useOwn ? (
        <>
          <Button variant="primary" size="lg" block onClick={finish}>
            Use this password
          </Button>
          <button
            type="button"
            onClick={() => setUseOwn(true)}
            className="cursor-pointer self-start text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink underline decoration-swiss-ink/30 underline-offset-4 transition-colors duration-150 ease-linear hover:decoration-swiss-accent-text"
          >
            Type my own instead
          </button>
        </>
      ) : (
        /* -- they want their own ---------------------------------------- */
        <form
          id="auth-form"
          noValidate
          onSubmit={submitOwn}
          className="flex flex-col gap-6"
        >
          {ownProblem !== null ? <Alert>{ownProblem}</Alert> : null}

          <PasswordField
            label="Your password"
            name="password-own"
            autoComplete="new-password"
            value={own.first}
            hint="Minimum 8 characters, with one letter and one number."
            error={ownTouched ? (ownProblems.first ?? undefined) : undefined}
            onChange={(event) => {
              setOwn((current) => ({ ...current, first: event.target.value }))
              setOwnProblem(null)
            }}
          />

          <PasswordField
            label="Type it again"
            name="password-own-confirm"
            autoComplete="new-password"
            value={own.second}
            error={ownTouched ? (ownProblems.second ?? undefined) : undefined}
            onChange={(event) =>
              setOwn((current) => ({ ...current, second: event.target.value }))
            }
            onBlur={() => setOwnTouched(true)}
          />

          <Button type="submit" variant="primary" size="lg" block loading={saving}>
            {saving ? 'Saving' : 'Save and continue'}
          </Button>

          <button
            type="button"
            onClick={() => {
              setOwn({ first: '', second: '' })
              setOwnProblem(null)
              setUseOwn(false)
            }}
            className="cursor-pointer self-start text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink underline decoration-swiss-ink/30 underline-offset-4 transition-colors duration-150 ease-linear hover:decoration-swiss-accent-text"
          >
            Use the generated one instead
          </button>
        </form>
      )}
    </div>
  )

  const TITLES: Record<
    RegisterStep,
    { eyebrow: string; title: string; description: string }
  > = {
    details: {
      eyebrow: '02. Register',
      title: 'Register',
      description:
        'Three fields and you are in. Your name and mobile number identify you at the door — the QR pass is generated instantly.',
    },
    password: {
      eyebrow: '02. Your password',
      title: 'Save it',
      description:
        'Use this one, or type your own below. Either way you need it to log in on the day.',
    },
    done: {
      eyebrow: '02. Register',
      title: 'You are in',
      description: 'Your pass is ready.',
    },
  }

  /*
    When registration closes while this screen is up, the description is replaced too.

    The poll can close registration underneath somebody who has the form open, and
    "Three fields and you are in" above a panel that says registration is closed is a
    small lie that makes the whole page read as broken rather than as deliberately
    shut. `registrationClosed` only ever turns this on for the details step, so the
    password screen is never affected — by then the account exists and closing
    registration has no bearing on it.
  */
  const shown = registrationClosed
    ? {
        eyebrow: '02. Register',
        title: 'Register',
        description:
          'Registration for this event is not open. If you already have a pass, log in and it will be waiting.',
      }
    : TITLES[step]

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

          {/*
            A plain router Link, not a `SlideNavLink`.

            `SlideNavLink` renders the label twice — once as the resting copy and once
            as an accent-coloured copy that slides over it on hover — which only works
            while the two occupy the same box. Styling the anchor as a full-width button
            was overriding the anchor's display and pulling the two apart, so hovering
            showed the label twice at once, accent-coloured on the left and paper-
            coloured in the middle. The button does not want a sliding text swap
            anyway; it wants to be a button.
          */}
          <Link
            to="/login"
            className="inline-flex min-h-12 items-center justify-center border-2 border-swiss-ink bg-swiss-ink px-6 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-paper transition-colors duration-150 ease-linear hover:bg-swiss-accent-text"
          >
            Log in →
          </Link>
        </div>
      ) : null}

      {/*
        The guest list is not announced here.

        It used to say "Guest list only — your SEN is checked against it". That was
        meant to be helpful and is mostly noise: it is a statement about the
        organiser's list on a page about the visitor's own details, and it tells a
        student on the list nothing useful while telling a student NOT on it that
        they are about to be refused — which the form cannot help with either way.

        Enforcement is unchanged. Somebody not on the list is refused on submit, and
        the refusal names the list and the address to email, which is the only point
        at which that information helps anybody.
      */}
      {step === 'details' && !registrationClosed ? detailsScreen : null}

      {step === 'password' ? passwordScreen : null}

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
