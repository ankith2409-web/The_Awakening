/**
 * Who to write to.
 *
 * One address, and every place that says it says THIS one: the footer contact
 * link, the password help on the login page, the guest-list refusal, the
 * registration-closed refusal, and the note on a day attendance has been closed
 * for.
 *
 * It lives here rather than being declared in each component because it is the
 * kind of value that silently drifts. Two literals of the same address is how
 * you end up with one of them pointing at an inbox nobody reads — and on the
 * password help that failure is invisible until someone is locked out of their
 * own event pass.
 *
 * It had already drifted: the footer and the password help used this constant,
 * while three pieces of copy in `types.ts` and `AttendancePanel.tsx` each carried
 * their own literal. So the fix for changing the address was to find all four, and
 * `test:live` now asserts there is exactly one of them.
 */
export const CONTACT_EMAIL = 'gdgtechnicalteam@gmail.com'

/**
 * Pre-filled subject for a password-reset request.
 *
 * Not decoration: an email that arrives with a recognisable subject is one that
 * gets answered, and one that arrives as "hi" is the sort that sits in an inbox
 * until the event is over. The link sets it so the attendee does not have to
 * compose it.
 */
export const PASSWORD_RESET_SUBJECT = 'The Awakening — password reset'

/**
 * Pre-filled subject for anything the footer sends.
 *
 * The reason the address is on the page at all. A footer link reading "Contact us"
 * and nothing else is a promise with no address attached: the reader has to open
 * their mail client to find out where it goes, and if they guess wrong they either
 * write to nobody or start a thread with a stranger that the chapter never sees.
 *
 * So the address is printed. It is the one piece of text in the footer that is not
 * a link label, and that is what makes it read as an address rather than as a
 * heading.
 */
export const CONTACT_SUBJECT = 'The Awakening — enquiry'

/**
 * The team registration URL, in one place.
 *
 * It has its own QR on its own poster because it is a different question asked on a
 * different day: attendance is per person per day, a team registers once for the
 * challenge. Putting the two behind one code would mean the door's QR — which must
 * never be the admin one, and must open a box a stranger can type into — also
 * offered a form that writes to a different table.
 */
export const TEAM_PORTAL_PATH = '/team'