import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserMultiFormatReader } from '@zxing/browser'
import { Button } from './Button'

type CameraState = 'idle' | 'starting' | 'active' | 'denied' | 'unavailable'

/**
 * Live barcode scanning with the device camera.
 *
 * Uses ZXing rather than the native `BarcodeDetector` API. BarcodeDetector is
 * faster where it exists but is absent on iOS Safari and Firefox — and the
 * gate laptop is as likely to be a staff phone as a desk machine. One decoder
 * that works everywhere beats a fast path plus a fallback.
 *
 * The camera is a privacy-sensitive resource, so the stream is torn down on
 * unmount and whenever scanning is switched off — leaving it running would
 * keep the camera light on and the browser indicator on indefinitely.
 */
export function BarcodeScanner({
  onDetect,
  disabled = false,
}: {
  onDetect: (value: string) => void
  disabled?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<{ stop: () => void } | null>(null)
  const readerRef = useRef<BrowserMultiFormatReader | null>(null)
  // Guards against the decoder firing several times for one physical scan.
  const lastFire = useRef(0)

  const [state, setState] = useState<CameraState>('idle')

  const stop = useCallback(() => {
    controlsRef.current?.stop()
    controlsRef.current = null
    setState('idle')
  }, [])

  // Tear the stream down if the component unmounts mid-scan.
  useEffect(() => stop, [stop])

  const start = useCallback(async () => {
    setState('starting')

    if (!window.isSecureContext) {
      // getUserMedia is blocked outside HTTPS (localhost is exempt).
      setState('unavailable')
      return
    }

    try {
      // Loaded on demand. The decoder is ~480KB, and neither an attendee
      // reading their pass nor an admin typing a SEN should pay for it.
      const { BrowserMultiFormatReader } = await import('@zxing/browser')

      const reader = new BrowserMultiFormatReader()
      readerRef.current = reader

      const controls = await reader.decodeFromVideoDevice(
        undefined,
        videoRef.current ?? undefined,
        (result) => {
          if (!result) return
          const now = Date.now()
          // The decoder fires repeatedly for one physical scan.
          if (now - lastFire.current < 1500) return
          lastFire.current = now
          onDetect(result.getText())
        },
      )

      controlsRef.current = controls
      setState('active')
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : ''
      setState(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'denied'
          : 'unavailable',
      )
    }
  }, [onDetect])

  return (
    <div className="flex flex-col gap-4">
      {/*
        A fixed 4:3 stage so the layout does not jump when the stream starts.
        `object-cover` fills it without letterboxing on portrait phones.
      */}
      <div className="relative aspect-4/3 w-full overflow-hidden border-2 border-swiss-ink bg-swiss-ink">
        <video
          ref={videoRef}
          className="size-full object-cover"
          // iOS Safari refuses inline playback without these.
          playsInline
          muted
          aria-label="Camera preview"
        />

        {state === 'active' ? (
          <>
            {/* Geometric reticle: four corners, no rounded framing. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              {(
                [
                  'left-3 top-3 border-l-2 border-t-2',
                  'right-3 top-3 border-r-2 border-t-2',
                  'left-3 bottom-3 border-b-2 border-l-2',
                  'right-3 bottom-3 border-b-2 border-r-2',
                ] as const
              ).map((position) => (
                <span
                  key={position}
                  className={`absolute size-8 border-swiss-accent-text ${position}`}
                />
              ))}
            </div>
            <p className="pointer-events-none absolute inset-x-0 bottom-3 bg-swiss-ink/80 p-2 text-center text-2xs font-bold uppercase tracking-[0.2em] text-swiss-paper">
              Align the barcode inside the frame
            </p>
          </>
        ) : null}

        {state !== 'active' ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            {state === 'starting' ? (
              <p role="status" className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-paper">
                Starting camera…
              </p>
            ) : null}

            {state === 'idle' ? (
              <Button variant="accent" size="md" onClick={() => void start()} disabled={disabled}>
                Open camera
              </Button>
            ) : null}

            {state === 'denied' ? (
              <p className="text-center text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-paper">
                Camera blocked. Allow access in your browser settings, or
                type the SEN below.
              </p>
            ) : null}

            {state === 'unavailable' ? (
              <p className="text-center text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-paper">
                No camera available on this device. Type the SEN below.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {state === 'active' ? (
        <Button variant="secondary" size="md" block onClick={stop}>
          Stop camera
        </Button>
      ) : null}
    </div>
  )
}