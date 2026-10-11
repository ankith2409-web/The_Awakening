import { useEffect, useState } from 'react'
import type { Announcement } from '@/domain/types'

/**
 * The newest announcement, shown on arrival, and then getting out of the way.
 *
 * This is the half of a broadcast that does not need permission.
 *
 * Push reaches only the people who said yes, and "said yes" is a small, declining
 * number: the prompt is dismissed by most, and some browsers cannot show one at all.
 * Without a fallback those people are not merely un-notified — the owner has no way of
 * knowing they were missed, so a room change gets announced into a void.
 *
 * Shown here rather than as a toast because it has to survive: somebody who opens the
 * dashboard twenty minutes after lunch was called should still see it, and a toast
 * that had already gone would have told them nothing.
 *
 * ONE announcement, not a feed. The question worth answering is "what is true now",
 * not "what have I been told", and a stack of superseded messages is noise with a
 * deadline.
 */

/**
 * How long the banner sits before it retires.
 *
 * Long enough to be read and acted on — somebody has to cross the room, or walk to the
 * next one — and short enough that it is not permanently in the way. Five minutes is
 * about the longest anybody reads a two-line notice.
 */
const READ_WINDOW_MS = 5 * 60 * 1000

/**
 * How long the fade itself takes.
 *
 * Must match the transition in `index.css`, because the component unmounts on a timer
 * of its own rather than on an animation event. One place owns the number and the
 * other mirrors it; the alternative is listening for `animationend`, which does not
 * fire at all for a transition that has not started.
 */
const FADE_MS = 400

const SEEN_PREFIX = 'gdg.announcement.seen.'

/**
 * Every announcement this device has already been shown and has come back to.
 *
 * Keyed by announcement ID, so a NEW message is always shown regardless of what was
 * retired before. A single "seen" flag would silently swallow the next one, and that
 * is the failure that matters: this fallback exists for precisely the people the push
 * missed, so the thing they most need is for it never to suppress a later message.
 *
 * Enumerated from storage rather than remembered as one ID, because a device that sees
 * three announcements over two days has to know about all three.
 */
function readRetired(): ReadonlySet<string> {
  try {
    const retired = new Set<string>()
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(SEEN_PREFIX)) retired.add(key.slice(SEEN_PREFIX.length))
    }
    return retired
  } catch {
    /*
      `localStorage` throws rather than returning null when site data is blocked —
      private browsing on some browsers, some managed profiles. Losing the memory costs
      one repeat viewing of a two-line notice, which is a fair trade for the dashboard
      not breaking for somebody who has just walked into a venue.
    */
    return new Set()
  }
}

function remember(id: string): void {
  try {
    window.localStorage.setItem(SEEN_PREFIX + id, '1')
  } catch {
    // Nothing to do. The banner simply reappears on the next load.
  }
}

export function AnnouncementBanner({ announcement }: { announcement: Announcement | null }) {
  /*
    Seeded lazily, so the storage read happens during the first render rather than in
    an effect.

    An effect would paint the banner for one frame before discovering it had already
    been retired. On a phone that frame is a visible flash of a message that is already
    dealt with, on a dashboard that refreshes itself every five seconds.

    A function initialiser also means the read cannot run again on a later render and
    resurrect something the timer has just retired.
  */
  const [retired, setRetired] = useState<ReadonlySet<string>>(readRetired)

  /*
    Arriving and leaving are two events, not one.

    `retiring` covers the fade, and only after it finishes is the banner unmounted and
    the ID recorded. Fading and unmounting in one step is what left an invisible panel
    sitting in the layout in the first version — see the note on the CSS.
  */
  const [retiring, setRetiring] = useState(false)

  const id = announcement?.id ?? null
  const show = id !== null && !retired.has(id)

  useEffect(() => {
    if (!show || id === null) return

    // Fade first...
    const fade = window.setTimeout(() => setRetiring(true), READ_WINDOW_MS)

    // ...then unmount and record, so the fade is actually seen.
    const done = window.setTimeout(() => {
      remember(id)
      // Persist first, then retire: a failure to write storage leaves the banner
      // showing, which is recoverable, whereas retiring without persisting would make
      // it vanish on this device and reappear on the next.
      setRetired((current) => new Set(current).add(id))
    }, READ_WINDOW_MS + FADE_MS)

    /*
      Both cleared on unmount and whenever the announcement changes.

      A timer left running would retire a banner that is no longer on screen, and would
      then suppress the next announcement — which is the one message somebody was
      actually waiting for. The dependency is the ID rather than the object, so an
      identical object arriving on the next poll does not restart the clock, while a
      genuinely new message gets the full window instead of inheriting the remainder of
      the one before it.
    */
    return () => {
      window.clearTimeout(fade)
      window.clearTimeout(done)
    }
  }, [show, id])

  /*
    A different announcement arriving mid-fade must not inherit the outgoing one's
    fade. Resetting on the ID change means the new message appears at full strength,
    which is the whole reason the owner sent it.
  */
  const [lastId, setLastId] = useState<string | null>(id)
  if (id !== lastId) {
    setLastId(id)
    setRetiring(false)
  }

  if (!show || announcement === null) return null

  return (
    <aside
      /*
        `role="status"` rather than `alert`: this is information, not an error, and an
        alert interrupts whatever the attendee was doing. It is also polite to the
        screen reader, which reads it in its own time rather than cutting across.

        `aria-live` is what makes it announce if the poll brings a NEW one while
        somebody is looking at the page — without it the banner would appear silently,
        which is the one moment a live region is genuinely for.
      */
      role="status"
      aria-live="polite"
      data-retiring={retiring}
      /*
        Fades rather than vanishing, and is not dismissible by hand.

        An element removed instantly reads as a glitch, and a panel that blinks out
        unexplained on a self-refreshing page looks like something failing rather than
        like a message that has served its purpose.

        Only one way to remove it, and it is not the reader's. The owner decides when a
        message stops being relevant; a close button would add a second dismissal state
        for no gain, and would sit on the banner inviting the reader to decide the
        owner already decided.
      */
      className="gdg-announcement-retire border-2 border-swiss-ink bg-swiss-accent-text p-5"
    >
      <p className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
        {announcement.title}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-swiss-ink">{announcement.body}</p>
    </aside>
  )
}