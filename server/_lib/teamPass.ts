/**
 * The team pass email.
 *
 * Goes to the TEAM LEADER only, never to the members. The leader is the one who
 * answers for the team, and three copies of the same document arriving in a
 * group chat is how a set of details starts arriving in three slightly different
 * versions.
 *
 * BUILT DEFENSIVELY, and for the same reason the credentials mail is: every
 * value in here is typed by a student into a form, which means every value in
 * here is attacker-controlled text that ends up rendered as HTML in somebody's
 * inbox. `esc` is not optional.
 *
 * SWISS, and email-safe. Table layout, inline styles, no flexbox, no web fonts,
 * no background images. An email is rendered by whatever the reader's client
 * happens to be, and the two hard constraints are Outlook's Word engine and the
 * fact that most people never load remote assets at all — which is also why the
 * logos are inlined as data URIs rather than linked, and why they are optional.
 */
import { BRAND, chapterLogo, fetchAiLogo } from './brand.ts'

export interface TeamPassInput {
  readonly name: string
  readonly leaderName: string
  readonly leaderEmail: string
  readonly leaderPhone: string
  readonly members: readonly { readonly name: string; readonly sen: string; readonly isLeader: boolean }[]
}

/** Escapes for an HTML attribute AND text content. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The subject.
 *
 * Team name first, because that is what a leader with forty other emails scans
 * for. Newlines are stripped rather than folded: a `\n` in a subject line is
 * either dropped or rendered as a literal `n` depending on the client, and either
 * way it breaks the one line that has to read cleanly in a phone's notification.
 */
export function teamPassSubject(team: TeamPassInput): string {
  return `${String(team.name).replace(/[\r\n]+/g, ' ').trim()} — your team pass`
}

const INK = '#000000'
const MUTED = '#f2f2f2'
const ACCENT = '#d62500'
const PAPER = '#ffffff'

/**
 * The footer: the chapter's mark, the event's title, and who made it possible.
 *
 * BUILT AS A TABLE ROW AND NOTHING ELSE.
 *
 * A `<div>` with `margin-top` works in some clients and not others; a table cell
 * with `padding` works in all of them, including Outlook's Word engine, which is the
 * one renderer that cannot be avoided. The rule height comes from a `padding` on an
 * empty cell rather than a `border-top` on the row, because Outlook draws table
 * borders inconsistently at the edges of a cell.
 *
 * THE LOGOS ARE OPTIONAL, NOT REQUIRED. Both marks are null until somebody runs
 * `scripts/embed-brand.mjs`, and a missing mark renders as no mark at all rather
 * than as a broken-image icon in the header of the one document a team leader has
 * been told to keep. An email that is merely plain is still an email somebody can
 * read their SEN out of.
 */
function brandBlock(eventName: string): string {
  const marks = [chapterLogo, fetchAiLogo].filter((uri): uri is string => typeof uri === 'string')

  const markCells = marks
    .map(
      (uri, index) => `
                      <td align="${index === 0 ? 'left' : 'right'}" style="padding:0 ${index === 0 ? '16px 16px 0 0' : '0'};">
                        <img
                          src="${uri}"
                          alt="${esc(index === 0 ? 'Google Developer Groups On Campus' : 'fetch.ai')}"
                          width="150"
                          style="display:block;width:150px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;"
                        />
                      </td>`,
    )
    .join('')

  const markRow =
    marks.length > 0
      ? `
                    <tr>
                      <td style="padding:20px 0 0 0;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                          <tr>${markCells}
                          </tr>
                        </table>
                      </td>
                    </tr>`
      : ''

  return `
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    ${markRow}
                    <tr>
                      <td style="padding:18px 0 0 0;border-top:1px solid ${INK}22;">
                        <p style="margin:0;font-size:13px;line-height:1.4;font-weight:800;letter-spacing:-.01em;color:${INK};text-transform:uppercase;">
                          ${esc(eventName)}
                        </p>
                        <p style="margin:7px 0 0 0;font-size:11px;line-height:1.6;color:${INK};opacity:.7;">
                          <span style="font-weight:700;letter-spacing:.14em;text-transform:uppercase;">Powered by</span>
                          ${BRAND.poweredBy.map((name) => esc(name)).join(' &middot; ')}
                        </p>
                        <p style="margin:3px 0 0 0;font-size:11px;line-height:1.6;color:${INK};opacity:.7;">
                          <span style="font-weight:700;letter-spacing:.14em;text-transform:uppercase;">Sponsored by</span>
                          ${BRAND.sponsoredBy.map((name) => esc(name)).join(' &middot; ')}
                        </p>
                        <p style="margin:12px 0 0 0;font-size:11px;line-height:1.5;color:${INK};opacity:.5;">
                          You are receiving this because you registered as the team leader.
                        </p>
                      </td>
                    </tr>
                  </table>`
}


/**
 * The rows, in leader-first order.
 *
 * The leader is rendered first because they are the recipient and should be able
 * to find themselves without reading. The server already sorts them that way; it
 * is sorted again here so the document is right even if a caller hands it an
 * unsorted list.
 */
function orderedMembers(team: TeamPassInput) {
  return [...team.members].sort((a, b) => Number(b.isLeader) - Number(a.isLeader))
}

export function teamPassHtml(team: TeamPassInput): string {  /*
    THE MEMBERS AND THE MARKUP ARE TWO DIFFERENT VARIABLES, on purpose.

    They were one. `rows` was the array mapped and joined into a string, and the
    count line then read `rows.length` — the character length of the generated
    HTML. Every pass said "1555 members" where a team of three was registered.

    It survived a typecheck because `rows` really was a string and `.length` on a
    string is a number. It survived the API tests because the response, not this
    document, is what those assert. It was caught by rendering one pass and reading
    it, which is the only check that ever would have.
  */
  const members = orderedMembers(team)

  const rows = members
    .map(
      (member) => `
            <tr>
              <td style="padding:10px 12px;border-bottom:1px solid ${INK}22;font-size:15px;font-weight:700;color:${INK};vertical-align:top;">
                ${esc(member.name)}
                ${
                  member.isLeader
                    ? `<div style="margin-top:2px;font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:${ACCENT};font-weight:700;">Team leader</div>`
                    : ''
                }
              </td>
              <td style="padding:10px 12px;border-bottom:1px solid ${INK}22;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:${INK};white-space:nowrap;">
                ${esc(member.sen)}
              </td>
            </tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(teamPassSubject(team))}</title>
</head>
<!--
  Tables and inline styles only. No flexbox, no grid, no web fonts, no remote
  images: this has to survive Outlook's Word renderer and a client that has
  blocked every remote asset on the page.
-->
<body style="margin:0;padding:0;background:${MUTED};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${MUTED};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${PAPER};border:2px solid ${INK};">

          <tr>
            <td style="height:6px;background:${ACCENT};font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <tr>
            <td style="padding:28px 28px 8px 28px;">
              <p style="margin:0;font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:${ACCENT};font-weight:700;">
                The Awakening &middot; Team pass
              </p>
              <h1 style="margin:14px 0 0 0;font-size:34px;line-height:1.05;font-weight:900;letter-spacing:-.02em;color:${INK};text-transform:uppercase;">
                ${esc(team.name)}
              </h1>
              <p style="margin:8px 0 0 0;font-size:14px;color:${INK};opacity:.7;">
                ${members.length} members &middot; registered
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 28px 0 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${MUTED};border:2px solid ${INK};">
                <tr>
                  <td style="padding:9px 12px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:${INK};opacity:.65;border-bottom:1px solid ${INK}22;width:34%;">Name</td>
                  <td style="padding:9px 12px;font-size:14px;font-weight:700;color:${INK};border-bottom:1px solid ${INK}22;">${esc(team.leaderName)}</td>
                </tr>
                <tr>
                  <td style="padding:9px 12px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:${INK};opacity:.65;border-bottom:1px solid ${INK}22;">Email</td>
                  <td style="padding:9px 12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:${INK};border-bottom:1px solid ${INK}22;">${esc(team.leaderEmail)}</td>
                </tr>
                <tr>
                  <td style="padding:9px 12px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:${INK};opacity:.65;">Phone</td>
                  <td style="padding:9px 12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:${INK};">${esc(team.leaderPhone)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 28px 0 28px;">
              <p style="margin:0 0 8px 0;font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:${ACCENT};font-weight:700;">
                Members
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:2px solid ${INK};">
                ${rows}
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 28px 28px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${MUTED};">
                <tr>
                  <td style="padding:14px 16px;border-left:4px solid ${ACCENT};font-size:13px;line-height:1.5;color:${INK};">
                    Keep this. Every member is identified by their SEN at the door,
                    so whoever cannot find this message can still be admitted by
                    the number above.
                  </td>
                </tr>
              </table>

              ${brandBlock(team.name)}
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/**
 * The plain-text part.
 *
 * Sent alongside the HTML, not instead of it. Some clients — and every corporate
 * mail gateway that rewrites HTML — will show only this, and a team pass that
 * renders as an empty box in a corporate inbox is a team leader who cannot get
 * into the room.
 *
 * Laid out with fixed-width columns rather than prose, because the one thing
 * anybody reads on a phone in a corridor is the SEN.
 */
export function teamPassText(team: TeamPassInput): string {
  const members = orderedMembers(team)
  const width = Math.max(...members.map((m) => m.name.length), 4)

  const lines = members.map(
    (m) => `  ${m.name.padEnd(width)}  ${m.sen}${m.isLeader ? '   (team leader)' : ''}`,
  )

  return [
    'THE AWAKENING - TEAM PASS',
    '',
    team.name.toUpperCase(),
    `${members.length} members`,
    '',
    'TEAM LEADER',
    `  Name    ${team.leaderName}`,
    `  Email   ${team.leaderEmail}`,
    `  Phone   ${team.leaderPhone}`,
    '',
    'MEMBERS',
    ...lines,
    '',
    '-'.repeat(52),
    'Keep this. Every member is identified by their SEN at the',
    'door, so whoever cannot find this message can still be',
    'admitted by the number above.',
    '',
    'You are receiving this because you registered as the team leader.',
  ].join('\n')
}