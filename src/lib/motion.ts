import type { CSSProperties } from 'react'

/**
 * Stagger indices for list reveals.
 *
 * The cap is the point of this module. A 500-row attendance log rendered with an
 * uncapped 45ms step would take over twenty seconds to finish animating — and
 * every row after the eighth is noise anyway. Past the cap everything appears
 * together, which is correct: the animation exists to show the eye where a list
 * BEGINS, not to make anyone wait for it to end.
 *
 * The delay is a CSS-level concern (`.motion-stagger` reads `--i`), so it costs
 * no React state and cannot cause a re-render.
 */
export const STAGGER_CAP = 8

/** The `--i` custom property for one item in a staggered list. */
export function stagger(index: number): CSSProperties {
  return { '--i': Math.min(index, STAGGER_CAP) } as CSSProperties
}