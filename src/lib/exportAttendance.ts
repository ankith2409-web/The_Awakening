import type { CheckIn } from '@/domain/types'

/**
 * Downloads the attendance log for ONE day as an Excel-compatible file.
 *
 * SEN numbers ONLY, one per row, nothing else — no header, no name, no phone, no
 * time, no day column. That is the artefact the gate hands over, so anything extra
 * would only get in the way of whatever consumes it downstream.
 *
 * The header row was removed deliberately. A `SEN` header reads nicely in a
 * spreadsheet, but this file is meant to be pasted into a column or uploaded to a
 * system that already knows what the values are — where a header becomes a bogus
 * entry.
 *
 * WHY ONE DAY, AND WHY IT IS AN ARGUMENT:
 *
 * Attendance is now a record per person per day, so "the SENs" is ambiguous. Two
 * plausible readings — everyone who came at all, or everyone who came today —
 * produce different files, and picking the wrong one silently is how a
 * certificate list ends up with the wrong names on it.
 *
 * So the day is a required parameter. There is no default and no "all days"
 * option, because an export with an unstated basis is an export nobody can check
 * later. Two days are two files, produced deliberately.
 *
 * Someone who attends both days appears once in each. That is correct: each file
 * answers "who was in the room on the day this was taken".
 *
 * Format: CSV rather than a binary .xlsx. A CSV opens natively in Excel, needs no
 * library, and cannot break on a malformed cell. A UTF-8 BOM is written so Excel
 * detects the encoding instead of mangling the values.
 */
export function downloadAttendanceCsv(
  records: readonly CheckIn[],
  eventName: string,
  day: number,
) {
  /*
    Filtered here as well as in the UI, deliberately. The caller passes the whole
    log and names the day, so there is exactly one call shape and one place where
    "which rows belong in this file" is decided. A filter applied only in the
    component would let a future caller export the wrong slice without anything
    noticing.
  */
  const dayRecords = records.filter((record) => record.day === day)

  // One SEN per line, in the order they were scanned.
  const lines = dayRecords.map((record) => record.sen)

  // Quote defensively: a SEN containing a comma or quote must not shift a cell.
  const csv = lines.map((line) => `"${line.replace(/"/g, '""')}"`).join('\r\n')

  // BOM so Excel reads it as UTF-8 rather than the local codepage.
  const blob = new Blob([`﻿${csv}\r\n`], {
    type: 'text/csv;charset=utf-8;',
  })

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  // The day is in the FILENAME, not just in a column. Two files called
  // "attendance.csv" in the same Downloads folder is how the wrong one gets
  // attached to an email.
  link.download = `${slugify(eventName)}-day-${day}-attendance.csv`
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