import type { Announcement } from '@/domain/types'

/**
 * The newest announcement, shown on arrival.
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
 * that has already gone would have told them nothing.
 *
 * ONE announcement, not a feed. The useful question is "what is true now", not "what
 * have I been told", and a stack of superseded messages is just noise with a deadline.
 */
export function AnnouncementBanner({ announcement }: { announcement: Announcement | null }) {
  if (!announcement) return null

  return (
    <aside
      /*
        `role="status"` rather than `alert`: this is information, not an error, and an
        alert interrupts whatever the attendee was doing. It is also polite to the
        screen reader, which will read it on its own rather than cutting across.

        `aria-live` is what makes it announce if the poll brings a new one while
        somebody is looking at the page — without it the banner would appear silently,
        which is the one moment a live region is genuinely for.
      */
      role="status"
      aria-live="polite"
      className="border-2 border-swiss-ink bg-swiss-accent-text p-5"
    >
      <p className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
        {announcement.title}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-swiss-ink">{announcement.body}</p>
    </aside>
  )
}