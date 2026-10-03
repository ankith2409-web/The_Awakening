import { useId, useState } from 'react'

/**
 * The event mark.
 *
 * The artwork itself is a supplied asset — see `public/fetch-ai.svg`. This
 * component owns the *motion*, not the drawing, so swapping in a higher-
 * resolution or officially licensed file needs no code change.
 *
 * The monochrome "Swiss" state is produced with a CSS filter rather than a
 * second asset: `grayscale(1)` plus a contrast crush turns any mark into clean
 * black-on-white, which means there is only ever one file to keep in sync.
 *
 * The cycle runs 2s:
 *   0–42%    OFFICIAL — the full-colour mark, held still
 *   42–50%   GLITCH   — chromatic split, tear, flicker
 *   50–92%   SWISS    — the monochrome mark, held still
 *   92–100%  GLITCH   — back to OFFICIAL
 *
 * Scope note: this is the one deliberate exception to the design system's "no
 * decorative motion" rule. It is confined to the mark, so the glitch reads as
 * an identity moment rather than as the UI's overall personality.
 */
export function EventMark({
  className = '',
  src = '/fetch-ai.svg',
}: {
  className?: string
  /** Override to point at a different asset without touching the call sites. */
  src?: string
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')

  // A missing asset must degrade to a wordmark, never to a broken-image icon.
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span className={['flex items-center gap-3', className].filter(Boolean).join(' ')}>
        <span aria-hidden="true" className="size-4 bg-swiss-accent" />
        <span className="flex flex-col leading-none">
          <span className="text-xs font-black uppercase tracking-[0.12em] text-swiss-ink sm:text-sm sm:tracking-[0.16em]">
            The Awakening
          </span>
          <span className="mt-1 text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            Fetch AI · GDG
          </span>
        </span>
      </span>
    )
  }

  return (
    <div
      className={['gdg-glitch-cycle flex items-center gap-3 select-none', className]
        .filter(Boolean)
        .join(' ')}
    >
      {/*
        `multiply` makes a white-background asset blend into whatever it sits
        on, so the mark never shows up inside a white box against the muted
        grey panels.
      */}
      <span
        className="gdg-stage relative block size-9 shrink-0 sm:size-11"
        style={{ mixBlendMode: 'multiply', isolation: 'isolate' }}
      >
        {/* OFFICIAL — the asset, untouched. */}
        <img
          src={src}
          alt=""
          aria-hidden="true"
          onError={() => setFailed(true)}
          className="gdg-layer gdg-official absolute inset-0 size-full object-contain"
          draggable={false}
        />

        {/*
          SWISS — same asset, crushed to monochrome. `contrast` is what snaps
          the antialiased edges back to hard black instead of grey.
        */}
        <img
          src={src}
          alt=""
          aria-hidden="true"
          className="gdg-layer gdg-swiss absolute inset-0 size-full object-contain"
          style={{
            filter: 'grayscale(1) contrast(2.4) brightness(0.92)',
          }}
          draggable={false}
        />
      </span>

      <span className="flex flex-col leading-none">
        {/*
          Steps down on small screens: at 320px the full-size lockup plus the
          sign-out button would overflow, and truncating the event name is not
          an acceptable trade.
        */}
        <span className="gdg-wordmark text-xs font-black uppercase tracking-[0.12em] text-swiss-ink sm:text-sm sm:tracking-[0.16em]">
          The Awakening
        </span>
        <span className="relative mt-1 block h-3.5" aria-hidden="true">
          <span className="gdg-official-text absolute inset-0 text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            Fetch AI · GDG
          </span>
          <span className="gdg-swiss-text absolute inset-0 text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            Fetch AI · GDG
          </span>
        </span>
      </span>

      {/* Screen readers get a stable name; the layer swap is never announced. */}
      <span className="sr-only" id={`gdg-label-${uid}`}>
        Google Developer Groups — The Awakening: AI agents
      </span>
    </div>
  )
}
