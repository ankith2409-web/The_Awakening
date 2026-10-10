import type { AnchorHTMLAttributes, ComponentProps, ReactNode } from 'react'
import { Link } from 'react-router-dom'

/**
 * Numbered section prefix.
 *
 * The design system uses "01. System" style labels as an orienting device
 * across every screen. Centralised so the red + tracking combination is
 * defined exactly once.
 */
export function SectionLabel({
  index,
  children,
  className = '',
}: {
  index: string
  children: ReactNode
  className?: string
}) {
  return (
    <p
      className={[
        'flex items-baseline gap-3 text-2xs font-bold uppercase tracking-[0.25em]',
        className,
      ].join(' ')}
    >
      <span className="text-swiss-accent-text">{index}</span>
      <span className="text-swiss-ink">{children}</span>
    </p>
  )
}

/**
 * A form-level alert. Reserved for the accent colour's one legitimate
 * non-decorative job: signalling that something failed.
 */
export function Alert({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      role="alert"
      className={[
        'flex items-start gap-4 border-2 border-swiss-accent-text bg-swiss-accent-text p-4',
        className,
      ].join(' ')}
    >
      {/* Solid square marker: geometric, not an emoji or a triangle. */}
      <span aria-hidden="true" className="mt-1 size-3 shrink-0 bg-swiss-paper" />
      <p className="text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-paper">
        {children}
      </p>
    </div>
  )
}

/**
 * Inline link with the system's signature interaction: the visible label
 * slides up and out while a red duplicate slides in from below.
 *
 * Two stacked spans make the effect possible without animating layout. The
 * duplicate is aria-hidden so screen readers announce the label once.
 */
export function TextLink({
  children,
  className = '',
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) {
  return (
    <a
      {...rest}
      className={[
        'group relative inline-block overflow-hidden',
        'text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink',
        className,
      ].join(' ')}
    >
      <span className="block transition-transform duration-200 ease-linear group-hover:-translate-y-full">
        {children}
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-0 block translate-y-full text-swiss-accent-text transition-transform duration-200 ease-linear group-hover:translate-y-0"
      >
        {children}
      </span>
    </a>
  )
}

/**
 * The router-aware counterpart of TextLink.
 *
 * This exists because the obvious composition — <Link><SlideButton/></Link> —
 * nests a <button> inside an <a>, which is invalid HTML and gives keyboard and
 * screen-reader users two overlapping targets for one action. The animation
 * lives on the anchor itself instead, so there is exactly one control.
 *
 * The two copies of the label live inside an inner block, and that block is what
 * stacks them. It is there because the effect depends on the two spans sharing one
 * box, and that is not automatic: a caller who passes `inline-flex justify-center`
 * to make the link look like a full-width button overrides the anchor's display, and
 * the two copies then stop being stacked by the anchor at all. `justify-center`
 * centres the in-flow one and leaves the absolutely-positioned one pinned to the left
 * edge, so hovering showed the label twice at once — accent-coloured over on the
 * left, paper-coloured in the middle. Both are real positions; neither is where it
 * should be.
 *
 * An inner block the caller cannot reach with a display utility means the effect
 * keeps working whatever the anchor is styled as.
 */
export function SlideNavLink({
  to,
  children,
  className = '',
  ...rest
}: ComponentProps<typeof Link> & { children: ReactNode }) {
  return (
    <Link
      {...rest}
      to={to}
      className={[
        'group relative inline-block overflow-hidden',
        'text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink',
        className,
      ].join(' ')}
    >
      <span className="relative block">
        <span className="block transition-transform duration-200 ease-linear group-hover:-translate-y-full">
          {children}
        </span>
        <span
          aria-hidden="true"
          className="absolute inset-0 block translate-y-full text-swiss-accent-text transition-transform duration-200 ease-linear group-hover:translate-y-0"
        >
          {children}
        </span>
      </span>
    </Link>
  )
}