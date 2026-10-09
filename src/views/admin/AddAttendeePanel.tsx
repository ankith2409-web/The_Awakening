import { useCallback, useState } from 'react'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { portalApi } from '@/api'
import { VALIDATORS } from '@/auth/validation'

/**
 * Register one person by hand.
 *
 * For the case the guest list cannot cover: a walk-in who is not on it, somebody
 * added late, or a registration that failed on a phone number. It bypasses the
 * guest list on purpose — refusing would leave an organiser at a desk with no way to
 * do the one thing they are there to do.
 *
 * The password is CHOSEN BY THE ORGANISER and has to be read out to the attendee.
 * Generating one and showing it would be friendlier, but it would also put a
 * credential on a screen anyone walking past can see, which is exactly why the desk
 * password flow asks staff to read it aloud too.
 *
 * Field order matches the public registration form exactly, and the validators are
 * the SAME functions — so a person added here is held to precisely the standard one
 * who signed up is. A weaker path here would be a way around every rule added since.
 */
export function AddAttendeePanel({
  onAdded,
}: {
  onAdded: () => void
}) {
  const [values, setValues] = useState({ name: '', phone: '', sen: '', password: '' })
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const problems = {
    name: VALIDATORS.name(values.name),
    phone: VALIDATORS.phone(values.phone),
    sen: VALIDATORS.sen(values.sen),
    password: VALIDATORS.password(values.password),
  }

  const firstInvalid = (['name', 'phone', 'sen', 'password'] as const).find(
    (key) => problems[key] !== null,
  )

  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }))

  const blur = (key: keyof typeof values) => () =>
    setTouched((current) => ({ ...current, [key]: true }))

  // `Field` speaks the DOM's shape, so the handlers are adapters rather than a
  // component of its own — the same wiring the public registration form uses, so
  // the two behave identically.
  const change = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    set(key)(event.target.value)

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setNotice(null)
      setProblem(null)

      // Mark everything touched, so a submit that fails shows WHY rather than
      // silently refusing.
      setTouched({ name: true, phone: true, sen: true, password: true })
      if (firstInvalid !== undefined) return

      setBusy(true)
      try {
        const created = await portalApi.createAttendee({
          name: values.name.trim(),
          phone: values.phone,
          sen: values.sen,
          password: values.password,
        })

        setNotice(
          `${created.name} is registered. Read the password back to them — they will need it to log in.`,
        )
        setValues({ name: '', phone: '', sen: '', password: '' })
        setTouched({})
        onAdded()
      } catch (error) {
        setProblem(error instanceof Error ? error.message : 'Could not add that person.')
      } finally {
        setBusy(false)
      }
    },
    [firstInvalid, onAdded, values],
  )

  return (
    /*
      `min-w-0` is load-bearing, not decoration.

      A grid item's `min-width` is `auto`, which means it refuses to shrink below its
      own min-content width. Inside a two-column grid at phone width this panel then
      forced its column to 401px inside a 306px track, pushing the whole tab
      sideways: the intro sentence ran past the panel border and the page scrolled
      horizontally on a phone.

      The offending min-content is the intrinsic width of a file/`<input>` control,
      which no amount of `w-full` overrides.
    */
    <section className="min-w-0 border-2 border-swiss-ink">
      <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-4 py-3 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-paper sm:px-6">
        Add one person
      </h2>

      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <p className="text-2xs font-medium leading-relaxed text-content-muted">
          For somebody not on the guest list. Adds them straight to the roster —
          registration rules still apply, and the attempt is recorded.
        </p>

        {notice !== null ? (
          <p
            role="status"
            className="border-l-4 border-swiss-ink bg-swiss-muted p-3 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
          >
            {notice}
          </p>
        ) : null}

        {problem !== null ? (
          <p
            role="alert"
            className="border-l-4 border-swiss-accent-text bg-swiss-muted p-3 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
          >
            {problem}
          </p>
        ) : null}

        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <Field
            label="Full name"
            name="name"
            value={values.name}
            onChange={change('name')}
            onBlur={blur('name')}
            error={touched.name ? problems.name ?? undefined : undefined}
            autoComplete="off"
          />

          <Field
            label="Phone number"
            name="phone"
            value={values.phone}
            onChange={change('phone')}
            onBlur={blur('phone')}
            error={touched.phone ? problems.phone ?? undefined : undefined}
            inputMode="numeric"
            hint="Ten digits, no country code."
            autoComplete="off"
          />

          <Field
            label="SEN"
            name="sen"
            value={values.sen}
            onChange={change('sen')}
            onBlur={blur('sen')}
            error={touched.sen ? problems.sen ?? undefined : undefined}
            autoComplete="off"
          />

          <Field
            label="Password"
            name="password"
            type="password"
            value={values.password}
            onChange={change('password')}
            onBlur={blur('password')}
            error={touched.password ? problems.password ?? undefined : undefined}
            hint="Read it back to them."
            autoComplete="new-password"
          />

          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Add to the roster
          </Button>
        </form>
      </div>
    </section>
  )
}