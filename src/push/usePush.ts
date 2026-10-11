import { useCallback, useEffect, useRef, useState } from 'react'
import { portalApi } from '@/api'
import type { PushSubscriptionPayload } from '@/domain/types'

/**
 * Turning push on, from the browser's point of view.
 *
 * Everything awkward about this feature is the browser refusing to be told what to do,
 * and every decision below exists to be honest about one of those refusals rather than
 * to route around it.
 */

/**
 * Why push is not available, when it is not.
 *
 * `null` means "no reason to show anything" — either it works, or the user has already
 * answered and the answer was no. Those are the only states where the toggle should be
 * silent, because a toggle that re-appears after being dismissed is a nag, and a nag
 * costs more goodwill than a missing notification.
 */
export type PushBlocker =
  /** The browser has no service workers, no push, or no notifications at all. */
  | 'unsupported'
  /**
   * Safari only grants push to a web app that has been added to the home screen. In a
   * plain tab it is not merely blocked — it is unavailable, and the prompt never
   * appears, so the user would be tapping a button forever.
   */
  | 'needs_home_screen'
  /** The user said no. Terminal until they change it in browser settings. */
  | 'denied'
  /** This deployment has no VAPID keys, so there is nothing to subscribe against. */
  | 'not_configured'

export type PushStatus =
  | 'checking'
  | 'off'
  | 'on'
  /** A click is in flight, so the button must not be double-submitted. */
  | 'working'
  | 'blocked'

export interface UsePush {
  status: PushStatus
  blocker: PushBlocker | null
  /**
   * True when the browser is subscribed but the server has not been told yet,
   * because there was no session to tell it with.
   *
   * Not an error and not a separate state to track: it is exactly "on, and not
   * authenticated", which is the normal state on the login and register pages.
   * The dashboard's next mount registers it. Derived rather than stored, so it
   * cannot disagree with the two values it is derived from.
   */
  readonly pending: boolean
  enable(): Promise<void>
  disable(): Promise<void>
}

const WORKER_URL = '/sw.js'

/**
 * Whether this browser can do push at all, and if not, which wall it hit.
 *
 * Checked rather than attempted. `Notification.requestPermission()` on an unsupported
 * browser is at best a no-op and at worst a thrown TypeError, and either way the user
 * is left pressing a button that will never work.
 *
 * The Safari check is the fiddly one. Safari has supported the Notification API for
 * years but has only supported *push* since 16.4, and only for a web app that has been
 * installed. So the test is not "is this Safari" but "is this a Safari that cannot do
 * push", which is what `standalone` distinguishes: in a normal tab it is false and push
 * genuinely is unavailable.
 */
function detectBlocker(): PushBlocker | null {
  if (typeof window === 'undefined') return 'unsupported'
  if (!('serviceWorker' in navigator)) return 'unsupported'
  if (!('PushManager' in window)) return 'unsupported'
  if (!('Notification' in window)) return 'unsupported'

  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent)
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent)

  if (isIos && isSafari) {
    const installed =
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches
    if (!installed) return 'needs_home_screen'
  }

  if (Notification.permission === 'denied') return 'denied'
  return null
}

/**
 * Turn a browser `PushSubscription` into the wire shape.
 *
 * The subscription's own JSON is close to right but includes fields the server does
 * not want and omits the guarantee that `keys` is present. Typed rather than cast,
 * because a missing `keys` here would otherwise be discovered by Postgres.
 */
function toPayload(subscription: PushSubscription): PushSubscriptionPayload | null {
  const json = subscription.toJSON() as {
    endpoint?: unknown
    keys?: { p256dh?: unknown; auth?: unknown }
  }
  const { endpoint, keys } = json
  if (typeof endpoint !== 'string' || !keys) return null
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
}

/**
 * Convert a base64 VAPID key into the uncompressed P-256 form the browser expects.
 *
 * `applicationServerKey` takes raw bytes, and a URL-safe base64 string is not that.
 * The `padding` argument is deliberately absent: these keys are exactly 65 bytes, so
 * any padding in the input would be an error rather than something to strip.
 *
 * Backed by an explicit `ArrayBuffer` rather than `new Uint8Array(length)`, because
 * the latter is typed over `ArrayBufferLike` and `PushSubscriptionOptionsInit` wants a
 * view over a real `ArrayBuffer`. The distinction is invisible at runtime and
 * otherwise leaks into every caller's types.
 */
function toApplicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (publicKey.length % 4)) % 4)
  const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const output = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

/**
 * The service worker registration, or `null` if there isn't one.
 *
 * NOT `navigator.serviceWorker.ready`.
 *
 * `ready` is a promise that resolves when a worker becomes active, and it is
 * written for the case where you *know* one is coming. Called when none is
 * registered, it never settles — not rejects, not times out, just waits forever.
 *
 * That made the toggle render nothing at all, permanently, for exactly the people
 * it was written for: somebody arriving at the login page who has never turned
 * notifications on has no worker, so the first `await` in the read path hung and
 * the component sat in its `checking` state forever. `getRegistration` answers
 * immediately with `undefined` instead, which is a state the read path can handle.
 */
async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker.getRegistration('/')) ?? null
  } catch {
    return null
  }
}

/**
 * @param authenticated whether there is an attendee session to register with.
 *
 * The toggle is shown on the login and register pages as well as the dashboard,
 * because most people only decide to turn notifications on when they arrive and
 * read the login form. Those pages have no session, so `authenticated` is false.
 *
 * Nothing is staged in `localStorage` to carry a subscription across that gap,
 * and that is deliberate. `pushManager.subscribe()` needs no identity — it
 * returns an endpoint and two keys for whichever device it is on — and the
 * authenticated read below re-POSTs whatever subscription the browser reports,
 * every time it mounts. So a device that subscribed anonymously registers itself
 * the moment its owner has a session, with nothing to reconcile and nothing that
 * can go stale between the two. A stored copy would be a second source of truth
 * for a value the browser already keeps authoritatively.
 */
export function usePush({ authenticated }: { readonly authenticated: boolean }): UsePush {
  const [status, setStatus] = useState<PushStatus>('checking')
  const [blocker, setBlocker] = useState<PushBlocker | null>(null)
  const [subscribed, setSubscribed] = useState(false)

  /*
    Held in a ref rather than read back from state.

    `disable` needs the current subscription to unsubscribe it. Waiting for React to
    re-render with it would mean the handler acts on the previous subscription, and
    unsubscribing the wrong one leaves the user with a notification they cannot turn
    off — which is the state most likely to make them deny the permission next time.
  */
  const current = useRef<PushSubscription | null>(null)

  useEffect(() => {
    let cancelled = false

    async function read(): Promise<void> {
      const blocked = detectBlocker()
      if (blocked) {
        if (cancelled) return
        setBlocker(blocked)
        setStatus('blocked')
        return
      }

      try {
        const registration = await currentRegistration()
        if (cancelled) return

        /*
          No worker means no subscription is possible, and saying so is the whole
          answer. `getSubscription` needs a registration to ask, so there is
          nothing to check and nothing to reconcile.
        */
        const existing = registration
          ? await registration.pushManager.getSubscription()
          : null
        if (cancelled) return
        current.current = existing

        const payload = existing ? toPayload(existing) : null

        /*
          Trust the SERVER over the browser on one point only.

          A local subscription can exist that we never recorded — the POST failed on a
          dead connection, or site data was cleared on our side but not the browser's.
          Re-sending it is one cheap request and makes the two agree; the reverse would
          mean the user believes they are subscribed and gets nothing.

          This is also how an anonymous subscription gets adopted: the same call, from
          the dashboard, with the session that says who the endpoint belongs to.
        */
        if (payload && authenticated) {
          try {
            await portalApi.subscribeToPush(payload)
            if (!cancelled) {
              setSubscribed(true)
              setStatus('on')
            }
            return
          } catch {
            if (!cancelled) setStatus('off')
            return
          }
        }

        /*
          Subscribed in the browser but with nothing to register it against. That is the
          honest state on the login and register pages, and `pending` in the return
          value is exactly this case rather than a separate thing to track.
        */
        if (payload && !authenticated) {
          setSubscribed(true)
          setStatus('on')
          return
        }

        if (!cancelled) {
          setSubscribed(false)
          setStatus('off')
        }
      } catch {
        if (!cancelled) setStatus('off')
      }
    }

    void read()
    return () => {
      cancelled = true
    }
  }, [authenticated])

  const enable = useCallback(async () => {
    setStatus('working')
    try {
      const { configured, publicKey } = await portalApi.getPushKey()
      if (!configured || !publicKey) {
        setBlocker('not_configured')
        setStatus('blocked')
        return
      }

      /*
        The permission prompt, and only from here.

        Browsers only allow it inside a user gesture, so this cannot be moved into an
        effect or run on page load no matter how much it would be more convenient.
        That is the whole reason this is a button and not an automatic prompt.
      */
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setBlocker('denied')
        setStatus('blocked')
        return
      }

      const registration = await navigator.serviceWorker.register(WORKER_URL, {
        scope: '/',
      })

      /*
        Safe here, unlike in the read path.

        `ready` only ever hangs when no worker is registered — and one was just
        registered, so it is a wait that terminates. It is kept because
        `pushManager.subscribe` on a worker that is still installing is refused by
        some browsers, and this is the one call in the file that can afford to
        wait for an active worker.
      */
      await navigator.serviceWorker.ready

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toApplicationServerKey(publicKey),
      })

      current.current = subscription

      const payload = toPayload(subscription)
      if (!payload) {
        setStatus('off')
        return
      }

      /*
        With a session the endpoint is registered now; without one the browser
        keeps it and the next authenticated mount registers it. Either way the
        subscription is real, so the state is on.
      */
      if (authenticated) await portalApi.subscribeToPush(payload)

      setSubscribed(true)
      setBlocker(null)
      setStatus('on')
    } catch {
      // A failed subscribe leaves the user with no notifications, which is "off".
      setStatus('off')
    }
  }, [authenticated])

  const disable = useCallback(async () => {
    setStatus('working')
    try {
      const registration = await currentRegistration()
      const subscription = current.current ?? (registration
        ? await registration.pushManager.getSubscription()
        : null)

      if (subscription) {
        /*
          Best effort, and only with a session.

          The server row is keyed to an attendee, so there is nothing to delete
          without one. Failing to delete it is survivable: the endpoint is about
          to be unsubscribed below, and the send path treats a dead endpoint as a
          prune rather than an error.
        */
        if (authenticated) {
          await portalApi
            .unsubscribeFromPush(subscription.endpoint)
            .catch(() => undefined)
        }
        await subscription.unsubscribe().catch(() => undefined)
      }

      current.current = null
      setSubscribed(false)
      setStatus('off')
    } catch {
      setStatus('off')
    }
  }, [authenticated])

  return { status, blocker, pending: subscribed && !authenticated, enable, disable }
}