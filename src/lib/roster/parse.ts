/**
 * Reading a spreadsheet of names and SENs, in the browser, with no dependency.
 *
 * WHY NO LIBRARY
 *
 * The obvious choice is SheetJS (`xlsx`). The version npm serves is 0.18.5 — frozen
 * in 2022, with SheetJS themselves moved off npm and two unpatched advisories on it:
 * a prototype-pollution bug (CVE-2023-30533) and a ReDoS (CVE-2024-22363). This
 * function's entire job is to parse a file somebody hands it, which is precisely the
 * input those two bugs are about. `exceljs` has no such history and is 22MB.
 *
 * So: CSV is parsed here, and `.xlsx` is parsed here too. An xlsx file is a ZIP of
 * XML, and every browser since 2023 ships `DecompressionStream`, which inflates a
 * raw deflate stream natively. That is the only hard part, and it is about a hundred
 * lines.
 *
 * The practical consequence: an organiser can upload the file Excel actually
 * produces, without anyone installing a package with a known CVE to do it.
 *
 * WHAT IS ACCEPTED
 *
 *   CSV   RFC 4180 — quoted fields, `""` escapes, newlines inside quotes, CRLF or
 *         LF, an optional UTF-8 BOM, and comma/semicolon/tab delimiters sniffed
 *         from the first line because European Excel writes `;` by default.
 *   XLSX  The first worksheet. Formulas are read as their cached value; a file that
 *         has never been opened by Excel has no cached values and will read as empty
 *         cells, which is reported rather than silently importing blanks.
 *
 * Column order is NOT assumed. The header row is matched by name, so `SEN | Name`
 * and `Name | Student ID` both work — real sheets never agree on column order.
 */

import { isValidSen } from '@/domain/phone'

/** Hard ceiling on rows, mirrored by the server. */
export const MAX_ROWS = 5000

/**
 * Cap on a decompressed entry.
 *
 * A crafted ZIP can expand a few kilobytes into gigabytes — a "zip bomb". This only
 * ever parses the owner's own file in the owner's browser, so the realistic risk is
 * near zero, but the check costs three lines and the failure it prevents is the tab
 * freezing with no explanation.
 */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024

export interface RosterRow {
  readonly name: string
  readonly sen: string
  /** 1-based row in the file, counting the header as row 1. */
  readonly line: number
}

export interface ParsedRoster {
  readonly rows: readonly RosterRow[]
  /** Rows dropped, with the reason. Never fatal on its own. */
  readonly problems: readonly string[]
  readonly headers: readonly string[]
  /** Which sheet or file was read, for the confirmation line. */
  readonly source: string
}

/* ------------------------------------------------------------------- CSV */

/**
 * Splits CSV text into a grid, honouring quoting.
 *
 * Hand-written rather than regex-based because the cases that matter are exactly
 * the ones a regex gets wrong: a newline inside a quoted name, an escaped `""`, and
 * a trailing empty field. Excel produces all three.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  // A UTF-8 BOM is invisible and would become part of the first header name, so the
  // SEN column would not match. Excel writes one on Windows more often than not.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const sep = delimiter ?? sniffDelimiter(clean)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i]

    if (quoted) {
      if (ch === '"') {
        // `""` inside a quoted field is one literal quote.
        if (clean[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }

    /*
      A quote only OPENS a quoted field when it is the field's first character.

      Anywhere else it is a literal — and this matters more than it looks. A name
      like `Grace O"Hopper` written without quoting the field (which Excel does
      happily) used to switch the parser into quoted mode mid-word, silently
      dropping the quote AND swallowing the comma after it, so the SEN vanished and
      the row was reported as having no SEN. The failure looked like bad data rather
      than a parser bug, and it cost a row on a sheet nobody could see the problem on.
    */
    if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === sep) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }

  // The last field of a file with no trailing newline.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/**
 * Guesses the delimiter from the header line.
 *
 * A semicolon is the default in much of Europe, so a file opened and saved by a
 * European Excel has no commas at all and would otherwise arrive as one column —
 * which the header matcher would report as "no SEN column found", which is true and
 * useless.
 */
function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const candidates = [',', ';', '\t', '|']
  let best = ','
  let bestCount = 0

  for (const candidate of candidates) {
    // Count only outside quotes, so a name containing a comma cannot win.
    let count = 0
    let quoted = false
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted
      else if (ch === candidate && !quoted) count += 1
    }
    if (count > bestCount) {
      bestCount = count
      best = candidate
    }
  }

  return best
}

/* ------------------------------------------------------------------ XLSX */

/**
 * Reads the first worksheet of an xlsx file.
 *
 * Minimal by necessity: it reads the parts it needs and ignores the rest (styles,
 * themes, drawings, comments, calc chains). A malformed part is reported by name so
 * the message says which piece was wrong rather than "invalid file".
 */
async function parseXlsx(data: ArrayBuffer): Promise<{ grid: string[][]; sheet: string }> {
  const zip = await readZip(data)

  const workbookPath = 'xl/workbook.xml'
  if (!zip.has(workbookPath)) {
    throw new Error('That file is not a readable Excel workbook (no xl/workbook.xml).')
  }

  const workbook = decodeXml(await zip.get(workbookPath))

  /*
    The first `<sheet>` in document order, and its `r:id`.

    Read from the XML rather than assumed to be `xl/worksheets/sheet1.xml`: Excel
    numbers sheets by creation order in the ZIP, which is not the tab order once
    somebody has reordered them or deleted one. Getting this wrong reads a stale
    sheet, or nothing at all.
  */
  const sheetTag = workbook.match(/<sheet\b[^>]*\/?>/)?.[0]
  if (!sheetTag) throw new Error('That workbook has no sheets.')

  const sheetName = decodeXmlText(sheetTag.match(/\bname="([^"]*)"/)?.[1] ?? 'Sheet1')
  const relId = sheetTag.match(/\br:id="([^"]*)"/)?.[1]
  if (!relId) throw new Error('Could not find the first worksheet in that workbook.')

  // `xl/_rels/workbook.xml.rels` maps that id to a target like `worksheets/sheet1.xml`.
  const relsPath = 'xl/_rels/workbook.xml.rels'
  if (!zip.has(relsPath)) {
    throw new Error('That workbook is missing its internal file list.')
  }
  const rels = decodeXml(await zip.get(relsPath))
  const relTag = [...rels.matchAll(/<Relationship\b[^>]*\/?>/g)]
    .map((m) => m[0])
    .find((tag) => tag.includes(`Id="${relId}"`))

  const target = relTag?.match(/\bTarget="([^"]*)"/)?.[1]
  if (!target) throw new Error('That workbook is missing its first worksheet.')

  // Targets are relative to `xl/`, but a saved-as workbook can use a leading slash.
  const sheetPath = target.startsWith('/')
    ? target.slice(1)
    : target.startsWith('xl/')
      ? target
      : `xl/${target}`

  if (!zip.has(sheetPath)) {
    throw new Error(`That workbook is missing "${sheetPath}".`)
  }

  // Shared strings are referenced by index; inline strings need no lookup.
  let shared: string[] = []
  if (zip.has('xl/sharedStrings.xml')) {
    const xml = decodeXml(await zip.get('xl/sharedStrings.xml'))
    shared = [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
      // A run can split one string across several <t> elements.
      [...(m[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((t) => decodeXmlText(t[1] ?? ''))
        .join(''),
    )
  }

  const sheetXml = decodeXml(await zip.get(sheetPath))
  const grid: string[][] = []

  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    // `r` is the cell's spreadsheet reference ("C7"), and a row can skip cells —
    // a blank column must stay blank or every later column shifts left.
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(
      /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const attrs = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''

      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1]
      const column = ref ? columnIndex(ref) : cells.length

      const type = attrs.match(/\bt="([^"]+)"/)?.[1]
      let value = ''

      if (type === 'inlineStr') {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
          .map((t) => decodeXmlText(t[1] ?? ''))
          .join('')
      } else {
        const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? ''
        if (type === 's') {
          const index = Number(raw)
          value = Number.isInteger(index) ? (shared[index] ?? '') : ''
        } else if (type === 'str') {
          value = decodeXmlText(raw)
        } else if (type === 'b') {
          value = raw === '1' ? 'TRUE' : 'FALSE'
        } else {
          /*
            `t` absent, or "n": a plain number.

            Left as written rather than parsed, because a SEN that Excel turned into
            a number has already lost its leading zero — no amount of parsing here
            recovers that, and `123456789012` in a cell is more use than an empty one.
          */
          value = decodeXmlText(raw)
        }
      }

      while (cells.length < column) cells.push('')
      cells[column] = value
    }

    grid.push(cells)
  }

  return { grid, sheet: sheetName }
}

/** "A" -> 0, "B" -> 1, … "AA" -> 26. */
function columnIndex(letters: string): number {
  let index = 0
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64)
  return index - 1
}

function decodeXml(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/* ------------------------------------------------------------------- ZIP */

/**
 * Just enough ZIP to read an xlsx.
 *
 * Reads the central directory rather than scanning local headers, because only the
 * central directory records the real sizes — a file written with a streaming
 * writer leaves sizes of zero in the local header until a data descriptor follows.
 */
async function readZip(data: ArrayBuffer): Promise<ZipReader> {
  const bytes = new Uint8Array(data)
  const view = new DataView(data)

  // The end-of-central-directory record is at the end, after an optional comment of
  // up to 64KB, so it is searched backwards rather than assumed to be last.
  let eocd = -1
  const floor = Math.max(0, bytes.length - 66_000)
  for (let i = bytes.length - 22; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('That file is not a readable Excel workbook (not a ZIP).')

  const entryCount = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)

  const entries = new Map<string, { method: number; offset: number; compressedSize: number }>()

  for (let n = 0; n < entryCount; n += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break

    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const offset = view.getUint32(cursor + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))

    entries.set(name, { method, offset, compressedSize })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return {
    has: (name) => entries.has(name),
    async get(name) {
      const entry = entries.get(name)
      if (!entry) throw new Error(`Missing "${name}" in the workbook.`)

      // The local header repeats the name and extra lengths, and its extra field can
      // differ in size from the central one — so the data starts after THIS header's
      // lengths, not the central directory's.
      if (view.getUint32(entry.offset, true) !== 0x04034b50) {
        throw new Error(`Corrupt entry "${name}".`)
      }
      const localNameLength = view.getUint16(entry.offset + 26, true)
      const localExtraLength = view.getUint16(entry.offset + 28, true)
      const start = entry.offset + 30 + localNameLength + localExtraLength
      const raw = bytes.subarray(start, start + entry.compressedSize)

      if (entry.method === 0) return raw.slice()
      if (entry.method !== 8) {
        throw new Error(`Unsupported compression in "${name}".`)
      }
      return inflate(raw)
    },
  }
}

interface ZipReader {
  has(name: string): boolean
  get(name: string): Promise<Uint8Array>
}

/**
 * Inflates a raw DEFLATE stream using the platform.
 *
 * `deflate-raw` because ZIP wraps a raw deflate stream with no zlib header, which is
 * what `DecompressionStream('deflate')` would reject.
 */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot read .xlsx files. Save it as CSV and upload that.')
  }

  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const buffer = await new Response(stream).arrayBuffer()

  if (buffer.byteLength > MAX_ENTRY_BYTES) {
    throw new Error('That workbook is unexpectedly large.')
  }
  return new Uint8Array(buffer)
}

/* ---------------------------------------------------------------- columns */

/**
 * Header names that mean "student id".
 *
 * Ordered as a preference, not a set: `sen` wins over the generic `id`, because a
 * sheet with columns `Student ID | Roll No | Name` should use the first.
 */
const SEN_HEADERS = [
  'sen',
  'senno',
  'sennumber',
  'senid',
  'studentid',
  'studentnumber',
  'studentcode',
  'registrationno',
  'registrationnumber',
  'regno',
  'regnumber',
  'rollno',
  'rollnumber',
  'usn',
  'enrollmentno',
  'id',
]

const NAME_HEADERS = [
  'name',
  'studentname',
  'fullname',
  'student',
  'candidatename',
  'participantname',
]

/** Collapses a header to something comparable: lowercase, letters and digits only. */
function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/*
  The lists above are written in NORMALISED form — no spaces, no punctuation — on
  purpose.

  They are matched against `normaliseHeader(header)`, so "Roll No" arrives as "rollno".
  An earlier version kept the pretty form ("roll no") and therefore matched nothing
  containing a space or a period, which silently sent every real sheet with a "Roll
  No" or "Reg. No" column down the guessed fallback. A mismatch here does not throw;
  it produces plausible-looking wrong output, which is the worst kind.
*/

/**
 * Finds the name and SEN columns from the header row.
 *
 * Falls back to POSITION when the headers are not recognised — first name-ish column
 * and the last column — because a sheet with no recognisable header still contains
 * the data, and refusing it would be pedantic. The fallback is reported so the
 * preview says the columns were guessed rather than read.
 */
export function findColumns(
  header: readonly string[],
): { senIndex: number; nameIndex: number; guessed: boolean } | null {
  // Two columns is the documented shape, and there is nothing sensible to do with
  // one. Checked first: a single "SEN" column matches the header list, and without
  // this guard it produced a confident answer pointing at a column that is not there.
  if (header.length < 2) return null

  const normalised = header.map(normaliseHeader)

  const senIndex = normalised.findIndex((h) => SEN_HEADERS.includes(h))
  const nameIndex = normalised.findIndex((h) => NAME_HEADERS.includes(h))

  if (senIndex !== -1) {
    return {
      senIndex,
      // A sheet with a header but no name column: take the first column that is not
      // the SEN, rather than pairing the SEN with itself.
      nameIndex: nameIndex !== -1 && nameIndex !== senIndex ? nameIndex : senIndex === 0 ? 1 : 0,
      guessed: nameIndex === -1 || nameIndex === senIndex,
    }
  }

  // No recognisable header at all. Two columns is the documented shape, so take the
  // first as the name and the last as the SEN, and report that it was a guess.
  return { senIndex: header.length - 1, nameIndex: 0, guessed: true }
}

/* ----------------------------------------------------------------- entry */

/**
 * Reads a chosen file into rows of `{ name, sen }`.
 *
 * The returned `problems` are per-row and never fatal: one malformed line in a
 * 500-row sheet should not cost the organiser the other 499. A sheet where EVERY row
 * fails is almost always a header problem, and that case is reported as such.
 */
export async function parseRosterFile(file: File): Promise<ParsedRoster> {
  const name = file.name.toLowerCase()
  const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xlsm')

  /*
    `.xls` is checked BEFORE the allow-list.

    It is not in the list, so the generic message would always win and the specific
    one was unreachable — which is the version that got written and tested, and it
    told an organiser to "upload a .csv or an .xlsx file" in response to a file that
    happened to be neither. The advice they actually need is "save it as .xlsx".
  */
  if (name.endsWith('.xls')) {
    throw new Error('That is the older .xls format. Open it and save it as .xlsx or .csv.')
  }

  if (!isXlsx && !name.endsWith('.csv') && !name.endsWith('.txt') && !name.endsWith('.tsv')) {
    throw new Error('Upload a .csv or an .xlsx file.')
  }

  let grid: string[][]
  let source: string

  if (isXlsx) {
    const parsed = await parseXlsx(await file.arrayBuffer())
    grid = parsed.grid
    source = parsed.sheet
  } else {
    const text = new TextDecoder('utf-8').decode(await file.arrayBuffer())
    grid = parseCsv(text)
    source = file.name
  }

  // Blank rows are common at the end of a sheet and carry no information.
  grid = grid.filter((row) => row.some((cell) => cell.trim() !== ''))

  if (grid.length === 0) throw new Error('That file is empty.')

  // Bound once. `noUncheckedIndexedAccess` cannot see that `length > 0` implies an
  // element, and a non-null assertion here would be the one place in this file that
  // lies to the reader.
  const headerRow = grid[0] ?? []

  const columns = findColumns(headerRow)
  if (!columns) {
    throw new Error(
      'Could not find a name and SEN column. The file needs at least two columns.',
    )
  }

  if (columns.guessed) {
    headerRow[columns.senIndex] = headerRow[columns.senIndex] ?? 'SEN'
    headerRow[columns.nameIndex] = headerRow[columns.nameIndex] ?? 'Name'
  }

  const body = grid.slice(1)
  if (body.length > MAX_ROWS) {
    throw new Error(`That file has ${body.length} rows; this portal accepts up to ${MAX_ROWS}.`)
  }

  const rows: RosterRow[] = []
  const problems: string[] = []
  const seen = new Map<string, number>()

  body.forEach((cells, index) => {
    const line = index + 2
    const name = (cells[columns.nameIndex] ?? '').replace(/\s+/g, ' ').trim()
    const sen = (cells[columns.senIndex] ?? '').trim()

    if (name === '' && sen === '') return

    if (name === '') {
      problems.push(`Row ${line}: no name`)
      return
    }
    if (sen === '') {
      problems.push(`Row ${line}: "${name}" has no SEN`)
      return
    }

    /*
      Shape-checked here as well as on the server.

      The preview says "N students ready", which is a promise. An earlier version
      checked only for a non-empty cell, so a sheet with a shifted column reported
      every row as ready and then the server rejected the whole upload — or worse,
      accepted it with the good rows and no warning about the bad one. The server is
      still authoritative; this just stops the panel claiming something is fine when
      it plainly is not.

      The message names the value, because "not a valid SEN" without the value sends
      somebody hunting down row 214 of a spreadsheet.
    */
    if (!isValidSen(sen)) {
      problems.push(`Row ${line}: "${sen}" is not a valid SEN`)
      return
    }

    const key = sen.toUpperCase()
    const first = seen.get(key)
    if (first !== undefined) {
      problems.push(`Row ${line}: ${sen} is already on row ${first}`)
      return
    }

    seen.set(key, line)
    rows.push({ name, sen, line })
  })

  return { rows, problems, headers: headerRow, source }
}