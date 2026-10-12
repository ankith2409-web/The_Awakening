/**
 * The credentials email.
 *
 * Every string here is escaped. `name` is attendee-supplied and goes into both
 * parts, and an unescaped name in the HTML part is an HTML injection in every
 * inbox the organiser sends to.
 *
 * It says clearly what to do if the reader did not register. That line is not
 * decoration: a mis-typed address sends somebody else a stranger's portal
 * password, and the honest thing is to tell them to ignore it and that we are
 * removing the database row rather than leaving them holding live credentials.
 */

export interface CredentialEmailInput {
  readonly name: string
  readonly phone: string
  readonly password: string
  readonly sen: string
  readonly portalUrl: string
  readonly supportEmail: string
  readonly eventName: string
  readonly eventDates: string
  readonly venue: string
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

/**
 * Personalised, because a name in the subject line is what tells somebody this
 * arrived for them rather than being another bulk message they are about to
 * delete unread.
 *
 * The name is attendee-supplied, so it is trimmed to a single line — a subject
 * header cannot hold a newline, and one would produce a malformed message that
 * some providers reject outright.
 */
export function credentialsSubject(name: string): string {
  const safe = name.replace(/\s+/g, ' ').trim().slice(0, 60)
  return safe === '' ? 'Your THE AWAKENING pass — log in details' : `${safe} — your THE AWAKENING login`
}

export function credentialsText(input: CredentialEmailInput): string {
  return [
    `Hello ${input.name},`,
    '',
    `Here are your details for ${input.eventName}.`,
    '',
    `  Portal   ${input.portalUrl}`,
    `  Name     ${input.name}`,
    `  Phone    ${input.phone}`,
    `  Password ${input.password}`,
    '',
    `Show the QR pass on your phone at the door. Your SEN is ${input.sen},`,
    `which is how your attendance is recorded.`,
    '',
    `${input.eventDates}`,
    `${input.venue}`,
    '',
    'You can change your password after logging in if you would rather have one of',
    'your own. Keep this email until then — the portal cannot show it to you again.',
    '',
    'If you did not register, or this is not your address, ignore this email. We',
    'will remove the record, and nobody has been given access to anything of yours.',
    '',
    `Questions: ${input.supportEmail}`,
  ].join('\n')
}

export function credentialsHtml(input: CredentialEmailInput): string {
  const row = (label: string, value: string, mono = false) => `
        <tr>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e5e5;color:#666;font:600 11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;text-transform:uppercase;letter-spacing:.12em;white-space:nowrap;">
            ${esc(label)}
          </td>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e5e5;color:#000;font:${mono ? '700 17px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace' : '400 17px/1.4 -apple-system,Segoe UI,Roboto,sans-serif'};letter-spacing:${mono ? '.04em' : 'normal'};">
            ${esc(value)}
          </td>
        </tr>`

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:2px solid #000;">

            <tr>
              <td style="background:#000;padding:16px 20px;">
                <span style="color:#ffffff;font:800 15px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.16em;text-transform:uppercase;">
                  The Awakening
                </span>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 20px 8px;">
                <h1 style="margin:0 0 8px;color:#000;font:800 26px/1.1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:-.02em;">
                  Your portal details
                </h1>
                <p style="margin:0;color:#444;font:400 15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;">
                  Hello ${esc(input.name)} — here is everything you need to show at the door.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 20px 4px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:2px solid #000;">
${row('Portal', input.portalUrl)}
${row('Name', input.name)}
${row('Phone', input.phone, true)}
${row('Password', input.password, true)}
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 20px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;border-left:4px solid #000;">
                  <tr>
                    <td style="padding:14px 16px;color:#333;font:400 14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;">
                      <strong>Open the portal and show the QR pass on your phone.</strong>
                      Your SEN is <strong>${esc(input.sen)}</strong> — that is how attendance is recorded.
                      <br><br>
                      ${esc(input.eventDates)}<br>
                      ${esc(input.venue)}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 20px 0;">
                <p style="margin:0;color:#555;font:400 14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;">
                  You can change your password after logging in. Keep this email until
                  you have — the portal cannot show it to you again.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 20px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff7e6;border:2px solid #000;">
                  <tr>
                    <td style="padding:14px 16px;color:#000;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;">
                      <strong>If you did not register, ignore this email.</strong>
                      It is not your address, so nothing here opens anything of yours,
                      and we will remove the record.
                    </td>
                  </tr>
                </table>
                <p style="margin:16px 0 0;color:#666;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;">
                  Questions: <a href="mailto:${esc(input.supportEmail)}" style="color:#000;">${esc(input.supportEmail)}</a>
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}