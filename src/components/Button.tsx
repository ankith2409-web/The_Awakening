import type { ButtonHTMLAttributes, ComponentProps, ReactNode, Ref } from 'react'
import { Link } from 'react-router-dom'

type Variant = 'primary' | 'secondary' | 'accent'
type Size = 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /** Swaps the label for a square progress indicator and blocks interaction. */
  loading?: boolean
  /** Square, full-width on mobile — used for form submission. */
  block?: boolean
  ref?: Ref<HTMLButtonElement>
}

/**
 * Interaction language: colour inversion, never a fade.
 * Primary (black) inverts to accent red. Secondary stays structural.
 */
/* The hover/solid reds use the text-safe variant: white label text sits on
   them, and #FF3000 would only reach 3.70:1 there. */
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-swiss-ink text-swiss-paper border-swiss-ink hover:bg-swiss-accent-text hover:border-swiss-accent-text',
  secondary:
    'bg-swiss-paper text-swiss-ink border-swiss-ink hover:bg-swiss-ink hover:text-swiss-paper',
  accent:
    'bg-swiss-accent-text text-swiss-paper border-swiss-accent-text hover:bg-swiss-ink hover:border-swiss-ink',
}

/* h-14 (56px) and h-16 (64px) clear the 44px minimum touch target with
   room to spare; uppercase tracking-wide matches the label typography.
   Padding and label size step down on small screens so a long label like
   "Sign out" cannot push the masthead off a 320px viewport. */
const SIZES: Record<Size, string> = {
  md: 'h-14 px-4 text-xs sm:px-6',
  lg: 'h-16 px-6 text-xs sm:px-8 sm:text-sm',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  disabled,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const isDisabled = disabled === true || loading

  return (
    <button
      {...rest}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={[
        'relative inline-flex items-center justify-center gap-3 border-2',
        'font-bold uppercase tracking-[0.15em]',
        'motion-press',
        'disabled:cursor-not-allowed disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        block ? 'w-full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {loading ? <Spinner /> : null}
      <span className={loading ? 'opacity-40' : undefined}>{children}</span>
    </button>
  )
}

/**
 * A square, deterministic mark. It scales with the button via currentColor
 * rather than a fixed pixel size so it inherits every variant.
 */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 shrink-0 animate-spin border-2 border-current border-t-transparent"
    />
  )
}

/**
 * A link that looks exactly like a Button.
 *
 * Exists because `Button` renders a `<button>` and a navigation action has to be
 * an `<a>` — right-click, middle-click and "open in new tab" all depend on it.
 * The variant and size maps are reused rather than copying class strings, which
 * is what a previous pass did inline and would drift the moment a variant
 * changed.
 */
export function ButtonLink({
  to,
  variant = 'primary',
  size = 'md',
  block = false,
  className = '',
  children,
  ...rest
}: ComponentProps<typeof Link> & {
  variant?: Variant
  size?: Size
  block?: boolean
}) {
  return (
    <Link
      {...rest}
      to={to}
      className={[
        'inline-flex items-center justify-center gap-3 border-2',
        'font-bold uppercase tracking-[0.15em]',
        'motion-press',
        VARIANTS[variant],
        SIZES[size],
        block ? 'w-full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </Link>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({ className = '', children, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      type="button"
      className={[
        'inline-flex size-11 cursor-pointer items-center justify-center',
        'border-2 border-swiss-ink bg-swiss-paper text-swiss-ink',
        'transition-colors duration-150 ease-linear',
        'hover:bg-swiss-accent hover:text-swiss-paper',
        className,
      ].join(' ')}
    >
      {children}
    </button>
  )
}