/**
 * A loading placeholder.
 *
 * The shimmer is the one permitted loop in the motion layer, and it earns that
 * exception: it covers a real wait. Without it a blank panel reads as a broken
 * page, so this is latency being masked rather than decoration.
 *
 * It stops the moment content replaces it, and `prefers-reduced-motion` collapses
 * it to a static tint — which still says "loading", because the dot texture and
 * the muted fill carry most of that meaning on their own.
 *
 * Still never a spinner: a spinner needs a size and a reading, whereas the
 * skeleton holds the panel's real geometry so nothing jumps when data lands.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={[
        'motion-skeleton swiss-dots border-2 border-swiss-ink/20',
        className,
      ].join(' ')}
    />
  )
}