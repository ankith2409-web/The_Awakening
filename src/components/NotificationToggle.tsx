import { usePush } from '@/push/usePush'

/**
 * The attendee's switch for notifications.
 *
 * Deliberately NOT a modal, and not automatic. Browsers only permit a permission
 * prompt inside a user gesture, so any design that interrupts somebody who has just
 * logged in is either impossible or a dark pattern. This is a button on their own
 * dashboard, in their own time, that does nothing at all until pressed.
 *
 * The important behaviour is what happens AFTER they say no.
 *
 * A toggle that reappears after being dismissed is a nag, and a nag costs more than a
 * missing notification — people who are annoyed by a prompt are the people who block
 * the whole site next time. So a refused permission, an unsupported browser and a
 * deployment with no keys all end with the control gone and a single line of plain
 * explanation. There is no retry, no re-ask, no badge.
 */

/** Shown in place of the control when it cannot work. One sentence, no instructions. */
const BLOCKER_COPY: Record<string, string> = {
  unsupported:
    'This browser cannot show notifications. Everything on this page works without them.',
  needs_home_screen:
    'On iPhone, notifications only work once you add this page to your home screen.',
  denied:
    'Notifications are turned off for this site. You can change that in your browser settings.',
  not_configured: 'Notifications are not available right now.',
}

export function NotificationToggle() {
  const { status, blocker, enable, disable } = usePush()

  /*
    Nothing while we are still finding out.

    Rendering the control optimistically and hiding it a moment later is a flicker on
    every single page load for every single attendee, and it is the flicker that most
    reliably makes a page feel like it is still loading.
  */
  if (status === 'checking') return null

  /*
    No control, but the reason stays.

    The one exception to going quiet is Safari on iPhone, because there the block is
    something the attendee CAN fix, in about two taps, and never finding out means the
    owner silently loses iPhones for the whole event.
  */
  if (status === 'blocked') {
    if (blocker === 'needs_home_screen') {
      return (
        <div className="border-l-4 border-swiss-ink bg-swiss-muted p-4">
          <p className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
            Notifications on iPhone
          </p>
          <p className="mt-2 text-2xs font-medium leading-relaxed text-content-muted">
            {BLOCKER_COPY.needs_home_screen} Tap Share, then Add to Home Screen, and open
            it from there. Everything on this page works either way.
          </p>
        </div>
      )
    }

    /*
      Everything else gets one quiet line.

      Said once, in the attendee's own dashboard, and never again. It exists so that
      somebody who expected a notification and did not get one is not left wondering
      whether the portal is broken — not to sell them the feature.
    */
    return (
      <p className="text-2xs font-medium leading-relaxed text-content-muted">
        {blocker !== null ? BLOCKER_COPY[blocker] : null}
      </p>
    )
  }

  if (status === 'on') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-l-4 border-swiss-ink bg-swiss-muted p-4">
        <p className="text-2xs font-medium leading-relaxed text-content-muted">
          Notifications are on. We will reach you here if something changes on the day.
        </p>
        <button
          type="button"
          onClick={() => void disable()}
          className="cursor-pointer border-b-2 border-swiss-ink pb-0.5 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink transition-colors duration-150 ease-linear hover:border-swiss-accent-text"
        >
          Turn off
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => void enable()}
      disabled={status === 'working'}
      className="flex w-full cursor-pointer items-center justify-between gap-4 border-l-4 border-swiss-ink bg-swiss-muted p-4 text-left transition-colors duration-150 ease-linear hover:bg-swiss-paper disabled:cursor-wait disabled:opacity-60"
    >
      <span>
        <span className="block text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
          Get notified on the day
        </span>
        <span className="mt-1 block text-2xs font-medium leading-relaxed text-content-muted">
          A message from the organisers, even if this page is closed.
        </span>
      </span>
      <span
        aria-hidden="true"
        className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink"
      >
        {status === 'working' ? '···' : 'On →'}
      </span>
    </button>
  )
}