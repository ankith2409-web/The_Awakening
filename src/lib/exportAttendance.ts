import type { CheckIn } from '@/domain/types'

/**
 * Downloads the attendance log as an Excel-compatible file.
 *
 * SEN numbers ONLY, one per row, nothing else — no header, no name, no phone,
 * no time. That is the artefact the gate hands over, so anything extra would
 * only get in the way of whatever consumes it downstream.
 *
 * The header row was removed deliberately. A `SEN` header reads nicely in a
 * spreadsheet, but this file is meant to be pasted into a column or uploaded
 * to a system that already knows what the values are — where a header becomes
 * a bogus entry.
 *
 * Format: CSV rather than a binary .xlsx. A CSV opens natively in Excel,
 * needs no library, and cannot break on a malformed cell. A UTF-8 BOM is
 * written so Excel detects the encoding instead of mangling the values.
 */
export function downloadAttendanceCsv(records: readonly CheckIn[], eventName: string) {
  // One SEN per line, in the order they were scanned.
  const lines = records.map((record) => record.sen)

  // Quote defensively: a SEN containing a comma or quote must not shift a cell.
  const csv = lines.map((line) => `"${line.replace(/"/g, '""')}"`).join('\r\n')

  // BOM so Excel reads it as UTF-8 rather than the local codepage.
  const blob = new Blob([`﻿${csv}\r\n`], {
    type: 'text/csv;charset=utf-8;',
  })

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${slugify(eventName)}-attendance.csv`
  document.body.append(link)
  link.click()
  link.remove()

  // Release the object URL once the download has been handed to the browser.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'event'
  )
}
