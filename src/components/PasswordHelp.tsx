/**
 * Where an attendee goes when they cannot get in.
 *
 * Its own component rather than a paragraph inside the login form, for two
 * reasons that both come from what this has to do:
 *
 *   It is not form copy. It is a different kind of instruction — not "fill this
 *   in", but "you are locked out, here is the next step". Keeping it in the form
 *   makes a failure path look like part of the sign-up flow, and people skim it.
 *
 *   It has a real link in it, and a link inside a `<label>`-adjacent run of form
 *   text is easy to miss and easy to make unclickable. It gets its own structure
 *   so the address is a thing you can tap, not a string you have to read out and
 *   retype.
 *
 * The copy is deliberately short. Someone who has forgotten their password is
 * stuck; the fastest thing this can do is be scannable in one glance, and every
 * extra sentence is a sentence they have to read before acting.
 */

import { CONTACT_EMAIL, PASSWORD_RESET_SUBJECT } from '@/domain/contact'

export function PasswordHelp({ className = '' }: { className?: string }) {
  return (
    <aside
      aria-labelledby="password-help-heading"
      className={[
        'border-2 border-swiss-ink bg-swiss-muted p-5',
        className,
      ].join(' ')}
    >
      {/*
        A square rather than an icon or a bullet. The whole layout uses geometric
        marks instead of pictograms, and this is not decorative — it is the thing
        that separates "you are blocked" from the rest of the form.
      */}
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 border-2 border-swiss-ink"
        />

        <div className="min-w-0 flex-1">
          <h2
            id="password-help-heading"
            className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-ink"
          >
            Forgotten your password
          </h2>

          <p className="mt-2 text-sm leading-relaxed text-content-muted">
            Passwords are reset by a person, never by this page. Email{' '}
            {/*
              Underlined by default and by focus, so it reads as a link before
              it is hovered. `wrap-anywhere` because a long address on a narrow
              phone must break rather than push the card sideways.
            */}
            <a
              href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
                PASSWORD_RESET_SUBJECT,
              )}`}
              className="font-mono font-bold text-swiss-ink underline decoration-2 underline-offset-4 transition-colors duration-150 ease-linear wrap-anywhere hover:text-swiss-accent-text focus-visible:text-swiss-accent-text"
            >
              {CONTACT_EMAIL}
            </a>{' '}
            with your name and registered phone number, and a new password will be
            set for you.
          </p>

          {/*
            The subject line is pre-filled by the link above, which saves the
            attendee composing it — and means the request arrives already
            identifiable. This line says so, because a pre-filled subject is
            invisible until the mail window opens.
          */}
          <p className="mt-3 border-t border-swiss-ink/20 pt-3 text-2xs uppercase tracking-[0.15em] text-content-muted">
            Subject line is filled in for you
          </p>
        </div>
      </div>
    </aside>
  )
}