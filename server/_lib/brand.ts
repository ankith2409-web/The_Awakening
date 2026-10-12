/**
 * Brand marks, as data URIs, for the team pass email.
 *
 * WHY THESE ARE INLINED RATHER THAN LINKED.
 *
 * Mail clients block remote images by default. Gmail, Outlook and Apple Mail all
 * withhold them behind a "display images" prompt, and Outlook.com and some corporate
 * gateways block them outright with no prompt at all. A `<img src="https://...">`
 * logo is therefore a logo that shows up for nobody, on the one document a team
 * leader has been told to keep.
 *
 * A `data:` URI cannot be withheld: it is part of the message, so it arrives or the
 * whole message did not. That is the only reliable way to put a picture in an email,
 * and it costs roughly 6KB of base64 for a small mark — cheap against a document
 * that is already a few kilobytes.
 *
 * Regenerate with:
 *   node scripts/embed-brand.mjs <path-to-png>
 *
 * THE MARKS THEMSELVES.
 *
 * `fetchAiLogo` is the Fetch.ai mark the event is run alongside. `chapterLogo` is
 * the Google Developer Groups On Campus mark for Amity University Bengaluru, supplied
 * by the organisers as `brand/gdg-oc-amity.png`.
 *
 * If `chapterLogo` is null the pass renders without it rather than with a broken
 * image: an email with no chapter mark is still a readable email, and one with a
 * broken image icon in the header is not.
 */

/** True when a mark has been supplied. Both are optional at runtime. */
export const fetchAiLogo: string | null = null

export const chapterLogo: string | null = null

/**
 * The credits that go under the logo block.
 *
 * `poweredBy` and `sponsoredBy` are data rather than markup so that the layout can
 * be changed without the words being at risk, and so a sponsor can be added without
 * anyone editing a template literal.
 */
export const BRAND = {
  /** The event's own title, shown in the footer. */
  title: 'The Awakening',

  poweredBy: ['fetch.ai', 'ASI:One'],

  sponsoredBy: ['PM'],
} as const
