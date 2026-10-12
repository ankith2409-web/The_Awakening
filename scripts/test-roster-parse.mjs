/**
 * Exercises the roster parser, including a real .xlsx built byte by byte.
 *
 * The xlsx case cannot be covered by a fixture file in the repo without either
 * committing a binary blob or trusting a library to produce one — so this builds a
 * genuine ZIP/OOXML file using the same deflate the reader expects, and reads it back
 * through the real parser.
 */
import { parseCsv, findColumns, parseRosterFile } from '../src/lib/roster/parse.ts'
import { isValidSen } from '../src/domain/phone.ts'
import { deflateRawSync } from 'node:zlib'

let passed = 0
let failed = 0

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok    ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/* --------------------------------------------------------------- helpers */

function crc32(buf) {
  let c
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())

  let crc = -1
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/** A minimal but genuinely valid ZIP containing the given name -> string entries. */
function makeZip(files) {
  const chunks = []
  const central = []
  let offset = 0

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const raw = Buffer.from(text, 'utf8')
    const compressed = deflateRawSync(raw)
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0, 6)           // flags
    local.writeUInt16LE(8, 8)           // deflate
    local.writeUInt16LE(0, 10)          // time
    local.writeUInt16LE(0, 12)          // date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBytes, compressed)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(compressed.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBytes.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)

    central.push(cd, nameBytes)
    offset += local.length + nameBytes.length + compressed.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return new Uint8Array(Buffer.concat([...chunks, centralBuf, eocd]))
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Builds a shared-strings workbook, the way Excel does — values by index. */
function makeXlsx(rows, { sheetName = 'Students', gap = false } = {}) {
  const shared = []
  const index = new Map()
  const sid = (value) => {
    if (index.has(value)) return index.get(value)
    const i = shared.length
    shared.push(value)
    index.set(value, i)
    return i
  }

  const rowXml = rows
    .map((cells, r) => {
      // `gap` skips column B, to prove blank cells do not shift later columns left.
      const out = []
      cells.forEach((value, c) => {
        if (gap && c === 1) return
        const letter = String.fromCharCode(65 + c)
        out.push(`<c r="${letter}${r + 1}" t="s"><v>${sid(String(value))}</v></c>`)
      })
      return `<row r="${r + 1}">${out.join('')}</row>`
    })
    .join('')

  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml':
      `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      `<?xml version="1.0"?><sst count="${shared.length}">${shared
        .map((s) => `<si><t>${esc(s)}</t></si>`)
        .join('')}</sst>`,
    'xl/worksheets/sheet1.xml':
      `<?xml version="1.0"?><worksheet><sheetData>${rowXml}</sheetData></worksheet>`,
  }

  return makeZip(files)
}

const asFile = (bytes, name) => {
  let blob
  return {
    name,
    arrayBuffer: async () => blob.arrayBuffer(),
    async _init() {
      blob = new Blob([bytes])
    },
  }
}

/**
 * Parses CSV text as a guest-list sheet, in one step.
 *
 * `asFile` exists for the binary and malformed cases, where how the file is
 * constructed is itself part of what is under test. It also needs its `_init`
 * called by hand before the bytes exist, and reaching for `_init` directly trips
 * the dangling-underscore rule — so a test that merely wanted to read a sheet had
 * two ways to be written and only one of them lint-clean.
 *
 * This builds the Blob inside `arrayBuffer` instead, which is what a real
 * `File` does and needs no second step.
 */
const readSheet = (text, name = 'roster.csv') =>
  parseRosterFile({
    name,
    arrayBuffer: async () => new Blob([new TextEncoder().encode(text)]).arrayBuffer(),
  })

/* ------------------------------------------------------------------ CSV */

console.log('\n  CSV parsing')

const quoted = parseCsv('Name,SEN\r\n"Ankith, A",A866175000012\r\n')
check('quoted comma stays in one field', quoted[1][0] === 'Ankith, A', JSON.stringify(quoted[1]))
check('CRLF handled', quoted[1][1] === 'A866175000012', JSON.stringify(quoted[1]))

const escaped = parseCsv('a,b\n"say ""hi""",2\n')
check('doubled quotes unescape', escaped[1][0] === 'say "hi"', JSON.stringify(escaped[1]))

const embedded = parseCsv('a,b\n"line1\nline2",2\n')
check('newline inside quotes kept', embedded[1][0] === 'line1\nline2', JSON.stringify(embedded[1]))

const semicolon = parseCsv('Name;SEN\nAnkith;A866175000012\n')
check('semicolon delimiter sniffed', semicolon[1][1] === 'A866175000012', JSON.stringify(semicolon[1]))

const bom = parseCsv('﻿Name,SEN\nAnkith,A866175000012\n')
check('BOM stripped from the first header', bom[0][0] === 'Name', JSON.stringify(bom[0][0]))

const trailing = parseCsv('a,b\n1,2\n')
check('no phantom row from a trailing newline', trailing.length === 2, `${trailing.length} rows`)

const noNewline = parseCsv('a,b\n1,2')
check('final field kept without a trailing newline', noNewline[1][1] === '2', JSON.stringify(noNewline[1]))

/*
  A quote that is NOT the first character of a field is a literal, not an opener.

  Found by uploading a sheet containing `Grace O"Hopper` — written unquoted, which
  Excel allows. The parser entered quoted mode mid-word, dropped the quote, and
  swallowed the comma after it, so the SEN disappeared and the row was reported as
  having no SEN. The row was silently lost and the message pointed at bad data
  rather than at the parser.
*/
const innerQuote = parseCsv('Name,SEN\nGrace O"Hopper,A866175000062\n')
check('a quote inside an unquoted field is kept', innerQuote[1][0] === 'Grace O"Hopper', JSON.stringify(innerQuote[1]))
check('and the column after it survives', innerQuote[1][1] === 'A866175000062', JSON.stringify(innerQuote[1]))

const stillQuoted = parseCsv('a,b\n"quoted, field",2\n')
check('a genuine quoted field still works', stillQuoted[1][0] === 'quoted, field', JSON.stringify(stillQuoted[1]))

const apostrophe = parseCsv("Name,SEN\nO'Neill,A866175000070\n")
check('an apostrophe is untouched', apostrophe[1][0] === "O'Neill", JSON.stringify(apostrophe[1]))

const quoteThenComma = parseCsv('a,b\nx"y,2\n')
check('a trailing quote does not eat the delimiter', quoteThenComma[1].length === 2, JSON.stringify(quoteThenComma[1]))

/* -------------------------------------------------------------- columns */

console.log('\n  column matching')

const senFirst = findColumns(['SEN', 'Name'])
check('SEN first', senFirst.senIndex === 0 && senFirst.nameIndex === 1, JSON.stringify(senFirst))

const nameFirst = findColumns(['Name', 'SEN'])
check('Name first', nameFirst.senIndex === 1 && nameFirst.nameIndex === 0, JSON.stringify(nameFirst))

const rollNo = findColumns(['Roll No', 'Student Name'])
check('roll number recognised as a SEN', rollNo.senIndex === 0, JSON.stringify(rollNo))

const messy = findColumns(['SL', 'NAME', 'Reg no'])
check('messy headers still resolved', messy.senIndex === 2 && messy.nameIndex === 1, JSON.stringify(messy))

const regNo = findColumns(['Name', 'Reg. No'])
check('a punctuated header still resolves', regNo.senIndex === 1, JSON.stringify(regNo))

const guessed = findColumns(['whatever', 'something else'])
check('unrecognised headers fall back to position, and say so',
  guessed?.senIndex === 1 && guessed?.guessed === true, JSON.stringify(guessed))

check('a single column is refused', findColumns(['SEN']) === null)

/* ----------------------------------------------------- the optional column */

console.log('\n  the optional email column')

/*
  Email is the only optional column, and "optional" has to mean three specific
  things or it is not optional at all:

    - its absence changes nothing about a two-column sheet,
    - it is never guessed from position, and
    - it can never be pointed at the SEN or the name.

  The third is the one that would do real damage: a column silently believed to
  hold addresses is where wrong addresses come from, and a wrong address is a
  credential handed to a stranger.
*/

check(
  'a two-column sheet reports no email column at all',
  senFirst.emailIndex === -1,
  JSON.stringify(senFirst),
)
check(
  'and that is not the same as an email column at index 0',
  findColumns(['Email', 'Name', 'SEN'])?.emailIndex === 0,
  JSON.stringify(findColumns(['Email', 'Name', 'SEN'])),
)
check(
  'the order of all three does not matter',
  findColumns(['Name', 'Email', 'SEN'])?.emailIndex === 1 &&
    findColumns(['SEN', 'Name', 'Email'])?.emailIndex === 2,
  JSON.stringify([findColumns(['Name', 'Email', 'SEN']), findColumns(['SEN', 'Name', 'Email'])]),
)
check(
  'common synonyms resolve',
  ['Email Address', 'Mail', 'Mail ID', 'E-mail'].every(
    (h) => findColumns(['Name', 'SEN', h])?.emailIndex === 2,
  ),
  JSON.stringify(['Email Address', 'Mail', 'Mail ID', 'E-mail'].map((h) => findColumns(['Name', 'SEN', h]))),
)

check(
  'an unrecognised header set never guesses an email column',
  findColumns(['Department', 'Roll No', 'Name'])?.emailIndex === -1,
  JSON.stringify(findColumns(['Department', 'Roll No', 'Name'])),
)
check(
  'a header that says Email but sits on the SEN column is refused',
  findColumns(['Email', 'SEN'])?.emailIndex === -1,
  JSON.stringify(findColumns(['Email', 'SEN'])),
)
check(
  'and one sitting on the name column likewise',
  findColumns(['Name', 'Email'])?.emailIndex === -1,
  JSON.stringify(findColumns(['Name', 'Email'])),
)

// -- read off the sheet

const withEmail = parseCsv(
  [['SEN', 'Name', 'Email'], ['A866175000012', 'Ankith Kumar', 'a@b.com']].join('\n'),
)
check('a sheet with an email column parses', withEmail.length === 2, `${withEmail.length} rows`)
check(
  'into three columns, header and all',
  withEmail[0].length === 3 && withEmail[0][2] === 'Email',
  JSON.stringify(withEmail),
)

const emailSheet = await readSheet(
  [
    'SEN,Name,Email',
    'A866175000012,Ankith Kumar,Ankith.Kumar@Example.COM',
    'A866175000013,Second Student,  spaced@out.com  ',
    'A866175000014,Third Student,',
    'A866175000015,Fourth Student,not an address',
  ].join('\n'),
)
check('every row still lands', emailSheet.rows.length === 4, JSON.stringify(emailSheet.rows))
check(
  'the address is lowercased, because two spellings of one inbox is one inbox',
  emailSheet.rows[0].email === 'ankith.kumar@example.com',
  JSON.stringify(emailSheet.rows[0]),
)
check(
  'and surrounding space is trimmed',
  emailSheet.rows[1].email === 'spaced@out.com',
  JSON.stringify(emailSheet.rows[1]),
)
check(
  'a blank cell is null, not an empty string',
  emailSheet.rows[2].email === null,
  JSON.stringify(emailSheet.rows[2]),
)
check(
  'a malformed address does NOT drop the row off the list',
  emailSheet.rows[3].sen === 'A866175000015' && emailSheet.rows[3].email === null,
  JSON.stringify(emailSheet.rows[3]),
)
check(
  'and it is reported, because silence would leave a column unexplained',
  emailSheet.problems.some((p) => /not a usable email address/.test(p) && /still on the list/.test(p)),
  JSON.stringify(emailSheet.problems),
)

const twoColumnSheet = await readSheet('SEN,Name\nA866175000012,Ankith Kumar\n')
check(
  'a two-column sheet parses exactly as it always did',
  twoColumnSheet.rows.length === 1 && twoColumnSheet.rows[0].email === null,
  JSON.stringify(twoColumnSheet.rows),
)
check('and reports no problem about a column that was never there',
  twoColumnSheet.problems.length === 0, JSON.stringify(twoColumnSheet.problems))

/* ----------------------------------------------------------------- XLSX */

console.log('\n  XLSX parsing')

const xlsxBytes = makeXlsx([
  ['Name', 'SEN'],
  ['Ankith Kumar', 'A866175000012'],
  ['Mary Ann', 'A866175000018'],
  ['José Álvarez', 'B866175999001'],
])
const xlsxFile = asFile(xlsxBytes, 'students.xlsx')
await xlsxFile._init()
const fromXlsx = await parseRosterFile(xlsxFile)
check('reads three students from a real xlsx', fromXlsx.rows.length === 3, `${fromXlsx.rows.length} rows`)
check('names survive', fromXlsx.rows[0]?.name === 'Ankith Kumar', JSON.stringify(fromXlsx.rows[0]))
check('SENs survive', fromXlsx.rows[2]?.sen === 'B866175999001', JSON.stringify(fromXlsx.rows[2]))
check('non-ASCII name survives', fromXlsx.rows[2]?.name === 'José Álvarez', JSON.stringify(fromXlsx.rows[2]?.name))
check('header row is not imported as a person', fromXlsx.rows.every((r) => r.name !== 'Name'))
check('sheet name reported', fromXlsx.source === 'Students', fromXlsx.source)

const gapped = asFile(
  makeXlsx([['Name', 'Gap', 'SEN'], ['Ankith', 'x', 'A866175000012']], { gap: true }),
  'gap.xlsx',
)
await gapped._init()
const gapResult = await parseRosterFile(gapped)
check('a blank middle column does not shift the SEN', gapResult.rows[0]?.sen === 'A866175000012', JSON.stringify(gapResult.rows[0]))

/* ------------------------------------------------------------- rejections */

console.log('\n  what it refuses')

const notASheet = asFile(new TextEncoder().encode('x,y\nAnkith,A866175000012'), 'notes.csv')
await notASheet._init()
try {
  const r = await parseRosterFile(notASheet)
  check(
    'an unrecognised header still reads, by position, and says it guessed',
    r.rows.length === 1 && r.rows[0].sen === 'A866175000012',
    JSON.stringify(r.rows),
  )
} catch (e) {
  check('an unrecognised header still reads, by position, and says it guessed', false, e.message)
}

const oldXls = asFile(new Uint8Array([1, 2, 3]), 'old.xls')
await oldXls._init()
try {
  await parseRosterFile(oldXls)
  check('.xls refused with a helpful message', false, 'it was accepted')
} catch (e) {
  check('.xls refused with a helpful message', /save it as/i.test(e.message), e.message)
}

const pdf = asFile(new Uint8Array([1, 2, 3]), 'list.pdf')
await pdf._init()
try {
  await parseRosterFile(pdf)
  check('a PDF is refused', false, 'it was accepted')
} catch (e) {
  check('a PDF is refused', /\.csv|\.xlsx/.test(e.message), e.message)
}

const notZip = asFile(new TextEncoder().encode('not a zip at all'), 'fake.xlsx')
await notZip._init()
try {
  await parseRosterFile(notZip)
  check('a non-ZIP named .xlsx is refused', false, 'it was accepted')
} catch (e) {
  check('a non-ZIP named .xlsx is refused', /not a zip|not a readable/i.test(e.message), e.message)
}

const oneColumn = asFile(new TextEncoder().encode('SEN\nA866175000012\n'), 'one.csv')
await oneColumn._init()
try {
  await parseRosterFile(oneColumn)
  check('a one-column file is refused', false, 'it was accepted')
} catch (e) {
  check('a one-column file is refused', /at least two columns/i.test(e.message), e.message)
}

const empty = asFile(new TextEncoder().encode(''), 'empty.csv')
await empty._init()
try {
  await parseRosterFile(empty)
  check('an empty file is refused', false, 'it was accepted')
} catch (e) {
  check('an empty file is refused', /empty/i.test(e.message), e.message)
}

/* ------------------------------------------------------- messy real rows */

console.log('\n  messy but real sheets')

const messyRows = asFile(
  new TextEncoder().encode(
    ['Name,SEN', 'Ankith,A866175000012', ',A866175000013', 'No Sen,,', 'Dup,A866175000012', 'Last,B866175999002', ''].join('\n'),
  ),
  'messy.csv',
)
await messyRows._init()
const messyResult = await parseRosterFile(messyRows)
check('good rows kept despite bad neighbours', messyResult.rows.length === 2, `${messyResult.rows.length} rows`)
check('a missing name is reported', messyResult.problems.some((p) => /no name/i.test(p)), messyResult.problems.join(' | '))
check('a missing SEN is reported', messyResult.problems.some((p) => /no SEN/i.test(p)), messyResult.problems.join(' | '))
check('a duplicate is reported once', messyResult.problems.filter((p) => /already on row/i.test(p)).length === 1, messyResult.problems.join(' | '))

const excelStyle = asFile(
  new TextEncoder().encode('"Name","SEN"\r\n"Ankith, Kumar","A866175000012"\r\n'),
  'excel.csv',
)
await excelStyle._init()
const excelResult = await parseRosterFile(excelStyle)
check('a file saved by Excel parses', excelResult.rows.length === 1 && excelResult.rows[0].name === 'Ankith, Kumar', JSON.stringify(excelResult.rows[0]))

/* ------------------------------------------------ the sheet from the browser */

console.log('\n  the exact sheet that found a bug')

// Uploaded through the real panel. `Grace O"Hopper` is unquoted, which Excel allows,
// and there is a three-column row that shifts the SEN column.
const fromBrowser = asFile(
  new TextEncoder().encode(
    [
      'Name,SEN',
      'Ankith Kumar,A866175000012',
      'Mary Ann,A866175000018',
      'José Álvarez,B866175999001',
      '山田太郎,C866175000044',
      'Ankith With,Comma,A866175000051',
      'Grace O"Hopper,A866175000062',
    ].join('\n'),
  ),
  'sample-students.csv',
)
await fromBrowser._init()
const sheet = await parseRosterFile(fromBrowser)

check('the quote-in-name row is no longer lost', sheet.rows.some((r) => r.name === 'Grace O"Hopper'), JSON.stringify(sheet.rows.map((r) => r.name)))
check(
  'and it is not reported as having no SEN',
  !sheet.problems.some((p) => /has no SEN/i.test(p)),
  sheet.problems.join(' | '),
)

/*
  The three-column row. With the header `Name,SEN` the SEN column is index 1, so
  this row reads SEN="Comma" — which is not a SEN.

  An earlier version did not shape-check on the client, so the panel announced
  "5 students ready" and the server then refused the whole upload. The preview has
  to agree with the server about what is valid.
*/
check(
  'a row whose SEN column is shifted is rejected in the preview',
  sheet.problems.some((p) => /"Comma" is not a valid SEN/i.test(p)),
  sheet.problems.join(' | '),
)
check(
  'so the ready count only claims rows that are actually usable',
  sheet.rows.length === 5 && sheet.rows.every((r) => isValidSen(r.sen)),
  `${sheet.rows.length} rows: ${sheet.rows.map((r) => r.sen).join(', ')}`,
)
check('the shifted row is not in the ready list', !sheet.rows.some((r) => r.sen === 'Comma'), 'Comma was offered as ready')
check('non-ASCII names still survive', sheet.rows.some((r) => r.name === '山田太郎'), JSON.stringify(sheet.rows.map((r) => r.name)))

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1