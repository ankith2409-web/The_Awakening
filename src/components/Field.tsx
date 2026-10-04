import { useId, useState, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'

export interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string
  /** Validation message. Presence flips the field into its error state. */
  error?: string | undefined
  /** Static hint shown below the control, hidden while an error is shown. */
  hint?: string
  /** Right-aligned control in the label row, e.g. a password "Show" toggle. */
  labelAction?: ReactNode
  /**
   * Forwarded to the underlying `<input>` through the rest spread.
   *
   * Declared explicitly because `InputHTMLAttributes` omits `ref`. React 19
   * treats `ref` as an ordinary prop, so a caller can reach the DOM node
   * without `Field` needing to know why.
   */
  ref?: Ref<HTMLInputElement>
}

export function Field({
  label,
  error,
  hint,
  labelAction,
  id,
  className = '',
  type = 'text',
  ...rest
}: FieldProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const errorId = `${inputId}-error`
  const hintId = `${inputId}-hint`

  const describedBy =
    [error ? errorId : null, !error && hint ? hintId : null]
      .filter(Boolean)
      .join(' ') || undefined

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <label
          htmlFor={inputId}
          className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink"
        >
          {label}
        </label>
        {labelAction}
      </div>

      <input
        {...rest}
        id={inputId}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={[
          'h-14 w-full border-2 bg-swiss-paper px-4',
          'font-medium text-swiss-ink placeholder:text-neutral-400',
          'transition-colors duration-150 ease-linear',
          'focus:border-swiss-accent-text focus:outline-none',
          error ? 'border-swiss-accent-text' : 'border-swiss-ink',
          className,
        ].join(' ')}
      />

      {/*
        aria-live so screen readers announce the message the moment validation
        fails, not only on the next focus change.
      */}
      <p
        id={errorId}
        role={error ? 'alert' : undefined}
        aria-live="polite"
        className="min-h-5 text-2xs font-bold uppercase tracking-[0.15em] text-swiss-accent-text"
      >
        {/*
          The message fades in rather than snapping. It occupies reserved height
          either way, so this cannot shift the layout — it only makes a
          background validation result legible while someone is typing quickly.
        */}
        <span key={error ?? 'none'} className={error ? 'motion-fade inline-block' : undefined}>
          {error ?? ''}
        </span>
      </p>

      {hint && !error ? (
        <p id={hintId} className="text-2xs text-content-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/**
 * A password field with a reveal toggle.
 *
 * The toggle is a real button with a pressed state, not a bare icon, so it is
 * reachable by keyboard and announced correctly.
 */
export function PasswordField(props: FieldProps) {
  const [visible, setVisible] = useState(false)
  const toggleId = `${props.id ?? 'password'}-reveal`

  return (
    <Field
      {...props}
      type={visible ? 'text' : 'password'}
      labelAction={
        <button
          type="button"
          id={toggleId}
          onClick={() => setVisible((current) => !current)}
          aria-pressed={visible}
          aria-controls={props.id}
          className={[
            'cursor-pointer text-2xs font-bold uppercase tracking-[0.2em]',
            'text-content-muted transition-colors duration-150 ease-linear',
            'hover:text-swiss-accent-text',
            visible ? 'text-swiss-accent-text' : '',
          ].join(' ')}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      }
    />
  )
}

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode
}

export function Checkbox({ label, id, className = '', ...rest }: CheckboxProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId

  return (
    // min-h-11 (44px) makes the whole row a compliant touch target while the
    // visible square stays 24px. The input itself sits on top of the square,
    // but the <label> is what actually forwards clicks to it.
    <label
      htmlFor={inputId}
      className="group flex min-h-11 cursor-pointer items-center gap-3 select-none"
    >
      {/*
        appearance-none removes the native control so the square can be styled
        to the grid. The peer/group combination handles the checked state.
      */}
      <span className="relative flex size-6 shrink-0 items-center justify-center border-2 border-swiss-ink bg-swiss-paper transition-colors duration-150 ease-linear group-hover:border-swiss-accent-text">
        <input
          {...rest}
          id={inputId}
          type="checkbox"
          className={[
            'peer absolute inset-0 size-full cursor-pointer appearance-none',
            className,
          ].join(' ')}
        />
        {/*
          A geometric tick, not a font glyph — drawn as a stroke so it scales
          cleanly and matches the weight of the surrounding type.
        */}
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="pointer-events-none relative size-4 scale-0 opacity-0 transition-transform duration-150 ease-linear peer-checked:scale-100 peer-checked:opacity-100"
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
        >
          <path d="M4 13L9 18L20 6" className="text-swiss-accent-text" />
        </svg>
      </span>

      <span className="text-2xs font-medium leading-relaxed text-swiss-ink">
        {label}
      </span>
    </label>
  )
}