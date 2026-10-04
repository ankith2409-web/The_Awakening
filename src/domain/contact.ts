/**
 * Who to write to.
 *
 * One address, used in two places: the footer contact link, and the password
 * help on the login page.
 *
 * It lives here rather than being declared in either component because it is the
 * kind of value that silently drifts. Two literals of the same address is how
 * you end up with one of them pointing at an inbox nobody reads — and on the
 * password help that failure is invisible until someone is locked out of their
 * own event pass.
 */
export const CONTACT_EMAIL = 'ankith2409@gmail.com'

/**
 * Pre-filled subject for a password-reset request.
 *
 * Not decoration: an email that arrives with a recognisable subject is one that
 * gets answered, and one that arrives as "hi" is the sort that sits in an inbox
 * until the event is over. The link sets it so the attendee does not have to
 * compose it.
 */
export const PASSWORD_RESET_SUBJECT = 'The Awakening — password reset'