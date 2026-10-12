/**
 * The WhatsApp group prompt, shown on the confirmation after a check-in.
 *
 * WHY IT IS ON THE CONFIRMATION AND NOT THE FORM
 *
 * The moment somebody presses "Mark me in" is the only moment they are provably in
 * the building. Before that they might never arrive; after that they have. A prompt
 * for a group that only exists for people who came is worth very little anywhere
 * else on the page, and worth almost everything here.
 *
 * IT IS THE LAST THING ON THE PAGE, AND IT HAS A BUTTON
 *
 * This is the one place the "no second action" rule does not apply. The rule exists
 * because "check in again" and "that is not my name" were both things that could not
 * work. Joining a group can, and not offering it is the difference between a group
 * with ninety members and a group with four.
 *
 * `target="_blank"` because a student who taps this while the phone is trying to
 * join the building's Wi-Fi should come back to this page and find their
 * confirmation still there. `rel="noreferrer noopener"` for the same reason — the
 * link must not be able to reach back into this tab.
 *
 * THE ICON IS DRAWN, NOT LINKED
 *
 * An inline path rather than a request to WhatsApp's CDN. Two reasons, both
 * practical: a third-party image that fails to load is a box with a gap in it in
 * the middle of the one screen that tells somebody they are registered, and a
 * network request to somebody else's host from a page handling a student's details
 * is a dependency this project does not need to take on event day.
 */

const WHATSAPP_GROUP = 'https://chat.whatsapp.com/CzS5TPFNKZYFHNrZAVuZep'

/**
 * The WhatsApp mark: a speech bubble with a handset in it.
 *
 * Drawn on a 24×24 grid to match the type around it, with the handset as a stroke
 * rather than a fill so it reads at 16px in the footer as well as at 32px on the
 * confirmation.
 */
function WhatsAppMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="square"
    >
      {/* The bubble. Open at the top-right where the tail will leave it. */}
      <path d="M20.2 11.6a8.2 8.2 0 0 1-12.1 7.3L3.5 20.5l1.6-4.5a8.2 8.2 0 1 1 15.1-4.4Z" />
      {/* The handset, angled the way a phone is held. */}
      <path d="M9.1 8.4c.2-.5.5-.5.8-.5h.6c.2 0 .4.1.5.4l.7 1.6c.1.3 0 .5-.1.7l-.5.6c-.2.2-.2.4-.1.6a6.7 6.7 0 0 0 3 2.6c.3.1.5 0 .7-.2l.5-.6c.2-.2.4-.3.7-.2l1.6.8c.3.1.4.3.4.6 0 .9-.7 1.7-1.6 1.9-1.2.3-3-.3-4.8-1.6a10.6 10.6 0 0 1-3.4-4.5c-.6-1.6-.5-2.9 0-3.5Z" />
    </svg>
  )
}

export function WhatsAppJoin() {
  return (
    <section
      aria-labelledby="whatsapp-heading"
      className="mt-12 border-2 border-swiss-ink"
    >
      <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
        <div className="flex items-start gap-4">
          <WhatsAppMark className="mt-0.5 size-8 shrink-0 text-swiss-accent-text" />
          <div>
            <h2
              id="whatsapp-heading"
              className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text"
            >
              Join the group
            </h2>
            <p className="mt-2 max-w-md text-sm font-medium leading-relaxed text-swiss-ink">
              You are in for today. Join the WhatsApp group for room changes,
              schedule updates and everything else that comes up while the event is
              running.
            </p>
          </div>
        </div>

        <a
          href={WHATSAPP_GROUP}
          target="_blank"
          rel="noreferrer noopener"
          className="group inline-flex shrink-0 items-center gap-3 border-2 border-swiss-ink px-5 py-3 font-mono text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink transition-colors duration-150 ease-linear hover:bg-swiss-ink hover:text-swiss-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-swiss-accent-text"
        >
          <WhatsAppMark className="size-4" />
          Join on WhatsApp
        </a>
      </div>
    </section>
  )
}
