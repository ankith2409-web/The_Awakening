import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { useAdmin } from '@/auth/contexts'
import { stagger } from '@/lib/motion'
import { VALIDATORS } from '@/auth/validation'
import { Button } from '@/components/Button'
import { Field, PasswordField } from '@/components/Field'
import { Skeleton } from '@/components/Skeleton'
import type { AdminRole, StaffAccount } from '@/domain/types'

/**
 * The two roles, in the words the panel uses.
 *
 * The `owner` label is "Full access" rather than "Owner". Nobody at an event
 * thinks of themselves as an owner, and the point of the column is what the
 * button does, not what the account is.
 */
const ROLE_LABEL: Record<AdminRole, string> = {
  owner: 'Full access',
  gate: 'Gate only',
}

const ROLE_HINT: Record<AdminRole, string> = {
  owner: 'Everything: the roster, passwords, the programme, staff accounts.',
  gate: 'Mark attendance, read the log, read teams. Nothing else.',
}

/**
 * Staff accounts: create one, change its role, reset it, switch it off.
 *
 * This exists because the alternative was a Vercel redeploy per volunteer, and
 * the moment somebody needs an account is the moment a deploy is least possible.
 *
 * Owner-only. The panel is only ever rendered behind an owner check, and every
 * route it calls re-checks the role on the server.
 *
 * Three rules are enforced by the server and surfaced here rather than
 * reimplemented, because a second copy of a rule is a second thing to get wrong:
 *
 *   you cannot change your own access
 *   you cannot remove the last full-access account
 *   you cannot deactivate the account you are signed in with
 *
 * Each surfaces as the banner with the server's own wording, which is why this
 * panel never guesses at the reason a request was refused.
 */
export function StaffPanel() {
  const { admin, staff, loadingData, refreshStaff, createStaff, updateStaff, clearError } =
    useAdmin()

  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    void refreshStaff()
  }, [refreshStaff])

  /*
    Ordered for reading, not for the database: full-access accounts first,
    because they are the ones you need to notice, then gate accounts
    alphabetically, then the disabled ones at the bottom where they are out of the
    way but still visible.
  */
  const ordered = useMemo(
    () =>
      [...staff].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1
        if (a.role !== b.role) return a.role === 'owner' ? -1 : 1
        return a.username.localeCompare(b.username)
      }),
    [staff],
  )

  const owners = staff.filter((person) => person.role === 'owner' && person.active).length

  if (loadingData && staff.length === 0) return <Skeleton className="h-64 w-full" />

  return (
    <div className="flex flex-col gap-6">
      {/*
        Stated up front because it is the thing that actually protects this
        panel: the last full-access account cannot be demoted or switched off.
        Someone reading this on event day should not have to wonder whether the
        person about to hand over the portal can still get in afterwards.
      */}
      <p className="border-l-4 border-swiss-ink bg-swiss-muted p-4 text-2xs font-medium leading-relaxed text-content-muted">
        <span className="font-bold uppercase tracking-[0.2em] text-swiss-ink">
          {owners} full-access {owners === 1 ? 'account' : 'accounts'}
        </span>{' '}
        — the last one cannot be demoted or switched off, and nobody can change
        their own access. Passwords are handed over in person; there is no reset
        link and no email.
      </p>

      {adding ? (
        <NewStaffForm
          onCancel={() => {
            clearError()
            setAdding(false)
          }}
          onCreate={async (input) => {
            const created = await createStaff(input)
            if (created !== null) {
              setAdding(false)
            }
          }}
        />
      ) : (
        <Button
          variant="primary"
          size="md"
          className="self-start"
          onClick={() => {
            clearError()
            setAdding(true)
          }}
        >
          Add someone
        </Button>
      )}

      {ordered.length === 0 ? (
        <p
          role="status"
          className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted"
        >
          No staff accounts listed
        </p>
      ) : (
        <ul className="flex flex-col border-t-2 border-swiss-ink">
          {ordered.map((person, index) => (
            <StaffRow
              key={person.id}
              person={person}
              index={index}
              isSelf={person.id === admin?.id}
              busy={busyId === person.id}
              /*
                Passed in rather than recomputed per row. The rule is about how
                many full-access accounts exist in TOTAL, so it is the parent's
                count to make — a row that worked it out alone would have to
                re-derive the whole list to answer a question about itself.
              */
              isLastOwner={person.role === 'owner' && person.active && owners === 1}
              onChange={async (patch) => {
                setBusyId(person.id)
                await updateStaff(person.id, patch)
                setBusyId(null)
              }}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/** One account, and the controls that change what it can do. */
function StaffRow({
  person,
  index,
  isSelf,
  busy,
  isLastOwner,
  onChange,
}: {
  readonly person: StaffAccount
  readonly index: number
  readonly isSelf: boolean
  readonly busy: boolean
  readonly isLastOwner: boolean
  readonly onChange: (
    patch: { role?: AdminRole; password?: string; active?: boolean },
  ) => Promise<void>
}) {
  const [resetting, setResetting] = useState(false)

  return (
    <li style={stagger(index)} className="motion-stagger border-b border-swiss-ink/15 py-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-lg font-black tracking-tight text-swiss-ink">
            {person.displayName}
            {isSelf ? (
              <span className="border border-swiss-ink px-2 py-0.5 text-2xs font-bold uppercase tracking-[0.15em] text-swiss-ink">
                You
              </span>
            ) : null}
            {!person.active ? (
              <span className="border-2 border-swiss-ink/40 px-2 py-0.5 text-2xs font-bold uppercase tracking-[0.15em] text-content-muted">
                Off
              </span>
            ) : null}
          </p>
          <p className="mt-1 font-mono text-2xs text-content-muted">{person.username}</p>
        </div>

        <div
          role="group"
          aria-label={`Access for ${person.displayName}`}
          className="flex gap-px border-2 border-swiss-ink"
        >
          {(Object.keys(ROLE_LABEL) as AdminRole[]).map((role) => (
            <button
              key={role}
              type="button"
              disabled={isSelf || busy}
              title={ROLE_HINT[role]}
              aria-pressed={person.role === role}
              onClick={() => {
                if (person.role !== role) void onChange({ role })
              }}
              className={[
                'min-h-11 cursor-pointer px-4 text-2xs font-bold uppercase tracking-[0.15em]',
                'transition-colors duration-150 ease-linear',
                'disabled:cursor-not-allowed disabled:opacity-40',
                person.role === role
                  ? 'bg-swiss-ink text-swiss-paper'
                  : 'bg-swiss-paper text-swiss-ink hover:bg-swiss-muted',
              ].join(' ')}
            >
              {ROLE_LABEL[role]}
            </button>
          ))}
        </div>
      </div>

      {isLastOwner && !isSelf ? (
        <p className="mt-3 text-2xs font-bold uppercase tracking-[0.15em] text-content-muted">
          Last full-access account — create another before changing this one
        </p>
      ) : null}

      {resetting ? (
        <ResetForm
          busy={busy}
          onCancel={() => setResetting(false)}
          onSubmit={async (password) => {
            await onChange({ password })
            setResetting(false)
          }}
        />
      ) : (
        <div className="mt-3 flex flex-wrap gap-3">
          <Button
            variant="secondary"
            size="md"
            disabled={isSelf || busy}
            onClick={() => setResetting((current) => !current)}
          >
            {resetting ? 'Cancel' : 'Set password'}
          </Button>
          {isSelf ? null : (
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => void onChange({ active: !person.active })}
            >
              {person.active ? 'Switch off' : 'Switch on'}
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

/** Inline password set for one account. Opens focused, like the Desk form. */
function ResetForm({
  busy,
  onCancel,
  onSubmit,
}: {
  readonly busy: boolean
  readonly onCancel: () => void
  readonly onSubmit: (password: string) => Promise<void>
}) {
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const fieldId = useId()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Validated on submit, never per keystroke: telling someone their password
    // is too short while they are still typing the first three characters is
    // hostile, and the same rule the attendee forms use.
    const found = VALIDATORS.password(password)
    if (found) {
      setProblem(found)
      return
    }
    setProblem(null)
    await onSubmit(password)
  }

  return (
    <form
      onSubmit={submit}
      className="mt-4 flex flex-col gap-4 border-2 border-swiss-ink bg-swiss-muted p-5 sm:flex-row sm:items-start"
    >
      <div className="flex-1">
        <PasswordField
          label="New password"
          id={fieldId}
          name="staff-reset-password"
          autoComplete="new-password"
          hint="At least 8 characters, with a letter and a number."
          value={password}
          error={problem ?? undefined}
          onChange={(event) => {
            setPassword(event.target.value)
            if (problem) setProblem(null)
          }}
        />
      </div>
      <div className="flex gap-3 sm:pt-8">
        <Button type="submit" variant="primary" size="md" loading={busy}>
          {busy ? 'Setting' : 'Set it'}
        </Button>
        <Button type="button" variant="secondary" size="md" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** The add-account form. */
function NewStaffForm({
  onCreate,
  onCancel,
}: {
  readonly onCreate: (input: {
    username: string
    displayName: string
    password: string
    role: AdminRole
  }) => Promise<void>
  readonly onCancel: () => void
}) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<AdminRole>('gate')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /*
    `gate` is the default, not `owner`.

    The common case is a volunteer at the door, and defaulting to the narrower
    role means the safe outcome is what you get by forgetting to change a
    dropdown. Granting full access has to be a deliberate act.
  */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const found = VALIDATORS.password(password)
    if (found) {
      setProblem(found)
      return
    }
    setProblem(null)
    setBusy(true)
    try {
      await onCreate({ username: username.trim(), displayName: displayName.trim(), password, role })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 border-2 border-swiss-ink bg-swiss-muted p-5"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          name="staff-display-name"
          autoComplete="off"
          hint="What other staff will see."
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <Field
          label="Username"
          name="staff-username"
          autoComplete="off"
          hint="Letters, numbers, dot, underscore, hyphen."
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>

      <PasswordField
        label="Password"
        name="staff-new-password"
        autoComplete="new-password"
        hint="At least 8 characters, with a letter and a number. Hand it over in person."
        value={password}
        error={problem ?? undefined}
        onChange={(event) => setPassword(event.target.value)}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
          Access
        </legend>
        <div className="flex gap-px border-2 border-swiss-ink">
          {(Object.keys(ROLE_LABEL) as AdminRole[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={role === value}
              title={ROLE_HINT[value]}
              onClick={() => setRole(value)}
              className={[
                'min-h-11 flex-1 cursor-pointer px-4 text-2xs font-bold uppercase tracking-[0.15em]',
                'transition-colors duration-150 ease-linear',
                role === value
                  ? 'bg-swiss-ink text-swiss-paper'
                  : 'bg-swiss-paper text-swiss-ink hover:bg-swiss-muted',
              ].join(' ')}
            >
              {ROLE_LABEL[value]}
            </button>
          ))}
        </div>
        <p className="text-2xs text-content-muted">{ROLE_HINT[role]}</p>
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" size="md" loading={busy}>
          {busy ? 'Creating' : 'Create account'}
        </Button>
        <Button type="button" variant="secondary" size="md" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}