/**
 * Site footer.
 *
 * The bottom of the page, in the shape a professional site uses: who is
 * hosting, who to reach, and the legal line. Nothing else — no sitemap, no
 * newsletter, no social row of icons. Four links and a credit is what this
 * event actually has, and padding a footer out to look like a corporation is
 * the same mistake as putting the programme back on the landing page.
 *
 * Layout is a single grid rather than four columns. The reference this follows
 * runs Event / Participate / Connect across the top with the host block on the
 * left; there is not enough here for three columns of links, and empty columns
 * read as broken. So: host on the far left, one Connect list beside it, then a
 * full-width rule and the copyright line.
 *
 * Swiss rules it obeys: structure is visible (2px ink rules), no rounded
 * anything, uppercase micro-labels at wide tracking, and the accent colour is
 * not used — a footer is not a signal.
 */

const HOST = {
  name: 'Amity University',
  campus: 'Bengaluru Campus',
  address: ['NH 207, Devanahalli', 'Bengaluru, Karnataka 562110'],
  website: 'https://amity.edu/bengaluru/',
} as const

const CONTACT_EMAIL = 'ankith2409@gmail.com'

const LINKS = [
  {
    label: 'GDG on Campus, Amity University',
    href: 'https://www.linkedin.com/company/gdgoc-aub/posts/',
  },
  {
    label: 'HB Mrudhal Ankith',
    // Lead developer. Named on the link rather than as a separate column so the
    // credit and the person are the same object — a reader clicking the name
    // knows exactly who built it.
    note: 'Lead developer',
    href: 'https://www.linkedin.com/in/hb-mrudhal-ankith-9834a23a2/?isSelfProfile=true',
  },
  { label: 'Amity University Bengaluru', href: HOST.website },
] as const

/**
 * External-link marker.
 *
 * A hollow square with a diagonal stroke — the system's geometric vocabulary,
 * not the conventional arrow-in-a-box, which would be the only rounded icon on
 * the page. `aria-hidden` because the link text already says where it goes, and
 * `title` carries it for sighted mouse users.
 */
function ExternalMark() {
  return (
    <span
      aria-hidden="true"
      title="Opens in a new tab"
      className="ml-2 inline-block size-2.5 shrink-0 translate-y-px border border-swiss-ink/45 not-italic"
      style={{ clipPath: 'polygon(0 0, 100% 0, 0 100%)' }}
    />
  )
}

function FooterLink({
  href,
  children,
  note,
}: {
  href: string
  children: React.ReactNode
  note?: string
}) {
  const isMail = href.startsWith('mailto:')

  return (
    <a
      href={href}
      {...(isMail ? {} : { target: '_blank', rel: 'noreferrer noopener' })}
      className="group flex items-baseline text-sm font-bold tracking-tight text-swiss-ink transition-colors duration-150 ease-linear hover:text-swiss-accent-text"
    >
      <span>{children}</span>
      {/*
        Role before the mark, not after. The mark is a trailing signal that the
        link leaves the site; putting it between the name and the role splits the
        phrase and reads as though the role is part of the destination.
      */}
      {note ? (
        // The role sits beside the name, not in the label: the link text must
        // stay the person's name so it reads correctly in a screen reader's list
        // of links, and so the name is what gets spoken.
        <span className="ml-2 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
          {note}
        </span>
      ) : null}
      {isMail ? null : <ExternalMark />}
    </a>
  )
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t-2 border-swiss-ink">
      <div className="px-6 py-12 sm:px-10 lg:px-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:gap-16">
          {/* Host — hard left, as the eye expects an identity block to be. */}
          <div>
            <h2 className="text-2xs font-bold uppercase tracking-[0.25em] text-content-muted">
              Hosted by
            </h2>
            <p className="mt-3 text-lg font-black leading-tight tracking-tight text-swiss-ink">
              {HOST.name}
            </p>
            <p className="text-sm font-medium text-content-muted">{HOST.campus}</p>

            <address className="mt-4 not-italic">
              {HOST.address.map((line) => (
                <span key={line} className="block text-sm text-content-muted">
                  {line}
                </span>
              ))}
            </address>
          </div>

          {/* Connect */}
          <div>
            <h2 className="text-2xs font-bold uppercase tracking-[0.25em] text-content-muted">
              Connect
            </h2>

            <ul className="mt-3 flex flex-col gap-3">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <FooterLink href={link.href} note={'note' in link ? link.note : undefined}>
                    {link.label}
                  </FooterLink>
                </li>
              ))}
              <li>
                <FooterLink href={`mailto:${CONTACT_EMAIL}`}>Contact us</FooterLink>
              </li>
            </ul>
          </div>
        </div>

        {/* Legal line. Its own rule, its own weight — subordinate to the links. */}
        <div className="mt-12 border-t border-swiss-ink/20 pt-6">
          <p className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            © 2026 Google Developer Groups · Amity University Bengaluru. All rights
            reserved.
          </p>
          <p className="mt-2 text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
            Built by{' '}
            <a
              href={LINKS[1].href}
              target="_blank"
              rel="noreferrer noopener"
              className="font-bold text-swiss-ink underline decoration-swiss-ink/30 underline-offset-4 transition-colors duration-150 ease-linear hover:decoration-swiss-accent-text"
            >
              HB Mrudhal Ankith
            </a>
          </p>
        </div>
      </div>
    </footer>
  )
}