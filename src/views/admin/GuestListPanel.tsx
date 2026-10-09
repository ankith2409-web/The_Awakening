import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { portalApi } from '@/api'
import type { RegistrationMode, RosterRows, RosterState } from '@/domain/types'
import { parseRosterFile, type ParsedRoster } from '@/lib/roster/parse'

/**
 * Upload a guest list, and choose whether registration is restricted to it.
 *
 * The shape of this panel is driven by one thing: the blast radius. Once a list is
 * enforced, every student not on it is refused at the registration form, with no
 * self-service route to fix it and no undo from the attendee side. So the file is
 * parsed and shown BEFORE anything is written, the count is stated plainly, and
 * nothing is replaced until somebody presses a button that says what it will do.
 *
 * Which is also why the file is parsed in the browser and only the rows are sent.
 * The server never handles a spreadsheet, so a format bug cannot take registration
 * down, and the preview is of exactly the rows that will be stored.
 *
 * Two deliberate non-features:
 *
 * - No "merge". An upload replaces. Someone who has left must stop being able to
 *   register, and merging makes a list impossible to shrink.
 * - No confirmation dialog. The panel already shows what will change, and a second
 *   "are you sure" trains people to click through dialogs without reading them —
 *   which is worse here, not better, because this one locks students out.
 */
export function GuestListPanel({
  mode,
  rosterCount,
  onModeChange,
}: {
  /** The live registration mode, so the upload can set it in the same action. */
  mode: RegistrationMode
  /**
   * The live count, straight off the polled event.
   *
   * Passed in rather than read from this panel's own fetch, because the switch above
   * reads the same number from `event` and the two would otherwise disagree on screen:
   * the header saying "4 students on the list" while this panel said "0". Two copies
   * of one fact, updating at different moments — the failure this codebase keeps
   * fixing.
   */
  rosterCount: number
  onModeChange: (mode: RegistrationMode) => void
}) {
  const [roster, setRoster] = useState<RosterState | null>(null)
  const [busy, setBusy] = useState(false)
  const [parsed, setParsed] = useState<ParsedRoster | null>(null)
  const [fileName, setFileName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  /* -- reading the stored rows back -------------------------------------- */

  const [rowsOpen, setRowsOpen] = useState(false)
  const [rows, setRows] = useState<RosterRows | null>(null)
  const [rowsProblem, setRowsProblem] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  /*
    Filtered in the browser, over the rows already fetched.

    Name OR SEN, because the two failures an organiser is looking for are different:
    a name that came out wrong is found by name, and a SEN that lost a character is
    found by SEN. Matching on name alone would make the second invisible.
  */
  const filtered = useMemo(() => {
    const all = rows?.rows ?? []
    const needle = filter.trim().toLowerCase()
    if (needle === '') return all
    return all.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.sen.toLowerCase().includes(needle),
    )
  }, [rows, filter])

  const fileRef = useRef<HTMLInputElement>(null)

  /*
    Fetched here rather than through `AdminProvider`.

    The roster is read by exactly one panel, on one tab, and adding it to the admin
    context would mean every admin render — including a `gate` account's, which must
    never receive a student's name — carries the field. Keeping it local means the
    request only happens when this panel is on screen.

    Re-read whenever `rosterCount` changes, which is the event poll telling us the list
    was replaced from another device. Without that, an upload on the laptop left the
    phone showing the previous list until it was reloaded.
  */
  useEffect(() => {
    let cancelled = false
    portalApi
      .getRoster()
      .then((state) => {
        if (!cancelled) setRoster(state)
      })
      .catch(() => {
        if (!cancelled) setProblem('Could not read the guest list.')
      })
    return () => {
      cancelled = true
    }
  }, [rosterCount])

  const current = roster

  async function handleFile(file: File) {
    setProblem(null)
    setDone(null)
    setParsed(null)
    setFileName(file.name)

    try {
      setParsed(await parseRosterFile(file))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Could not read that file.')
    }
  }

  /*
    The mode travels with the upload.

    Two buttons rather than one, because "save this list" and "start locking people
    out with it" are two different decisions with very different consequences, and
    neither is the obvious default the other time it is done.

    A third button is deliberately absent: closing registration outright is not
    something an upload does. That is the switch above, where it is stated plainly.
  */
  async function commit(next: RegistrationMode) {
    if (!parsed || parsed.rows.length === 0) return

    setBusy(true)
    setProblem(null)
    setDone(null)

    try {
      const result = await portalApi.uploadRoster(
        parsed.rows.map((row) => ({ name: row.name, sen: row.sen })),
        next,
      )

      const bits = [`${result.imported} student${result.imported === 1 ? '' : 's'} on the list`]
      if (result.skipped > 0) bits.push(`${result.skipped} row(s) skipped`)
      bits.push(
        next === 'restricted'
          ? 'registration now closed to everyone else'
          : 'registration still open to anyone',
      )

      setDone(bits.join(' · '))
      setParsed(null)
      setFileName('')
      if (fileRef.current) fileRef.current.value = ''
      setRoster(await portalApi.getRoster())
      if (next !== mode) onModeChange(next)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The upload failed.')
    } finally {
      setBusy(false)
    }
  }

  /*
    Clearing the list does NOT reopen registration.

    They used to be the same action, and that was a trap waiting to happen: tidying
    up a spreadsheet that turned out to have a duplicate SEN would have quietly shut
    the door to every remaining student, with the only visible sign being that
    signups stopped. The list is data; who may register is a separate decision, made
    in the switch above.

    So this clears, and says plainly what it did and did not do — and when the
    consequence is "nobody can now register", it offers the one click that undoes it.
  */
  /*
    Reads the whole list, on demand, and only while it is open.

    Fetched when the control is pressed rather than with the panel, and discarded when
    it is closed: the response is every student's name and SEN, and there is no reason
    for it to sit in memory on a device that has moved on. Toggling shut and open again
    re-reads, which is right — the list may have been replaced in another tab.
  */
  async function toggleRows() {
    if (rowsOpen) {
      setRowsOpen(false)
      setRows(null)
      setFilter('')
      setRowsProblem(null)
      return
    }

    setRowsOpen(true)
    setRowsProblem(null)
    try {
      setRows(await portalApi.listRosterRows())
    } catch (error) {
      setRowsProblem(
        error instanceof Error ? error.message : 'Could not read the list.',
      )
    }
  }

  async function clear() {
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      setRoster(await portalApi.clearRoster())
      if (mode === 'restricted') {
        setDone(
          'Guest list cleared · registration is still set to the guest list, so nobody can register right now',
        )
      } else {
        setDone(`Guest list cleared · registration is ${mode === 'closed' ? 'still closed to everyone' : 'open to anyone'}`)
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Could not clear the list.')
    } finally {
      setBusy(false)
    }
  }

  return (
    /*
      `min-w-0` is load-bearing, not decoration.

      A grid item's `min-width` is `auto`, so it will not shrink below its own
      min-content width. This panel contains a file input, whose intrinsic width no
      `w-full` overrides — in a two-column grid at phone width that forced the column
      to 401px inside a 306px track and pushed the whole tab sideways.
    */
    <section className="min-w-0 border-2 border-swiss-ink">
      <h2 className="border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper">
        Guest List
      </h2>

      <div className="flex flex-col gap-6 p-6">
        {/*
          The current state, stated in one sentence, because "is registration
          restricted right now?" is the question an organiser actually has and it has
          no other answer anywhere in the portal.
        */}
        <div className="border-l-4 border-swiss-ink bg-swiss-muted p-4">
          <p className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
            {current === null && rosterCount === 0
              ? 'Checking…'
              : rosterCount === 0
                ? 'No guest list uploaded'
                : `${rosterCount} student${rosterCount === 1 ? '' : 's'} on the list`}
          </p>

          {/*
            The list is data; the switch above decides what it means. Saying so here
            is the difference between an organiser understanding why registration is
            still open and wondering whether their upload silently failed.
          */}
          {rosterCount > 0 && mode !== 'restricted' ? (
            <p className="mt-2 text-2xs font-medium leading-relaxed text-content-muted">
              The list is uploaded but registration is not set to use it. Choose
              &ldquo;Guest list&rdquo; above to close registration to everyone not on
              it.
            </p>
          ) : null}

          {current !== null && current.count > 0 ? (
            <>
              {/*
                A sample, not the list. The owner uploaded the file; echoing 500 rows
                back into the browser serves nobody — and the "Check all N names"
                control below is how they see the lot, on demand.
              */}
              <ul className="mt-3 flex flex-col gap-1">
                {current.sample.map((row) => (
                  <li key={row.sen} className="font-mono text-2xs text-content-muted">
                    {row.sen} <span className="font-sans">{row.name}</span>
                  </li>
                ))}
              </ul>
              {current.count > current.sample.length ? (
                <p className="mt-2 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                  + {current.count - current.sample.length} more
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        {/* -- choose a file ------------------------------------------------- */}

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-2">
            <span className="text-2xs font-bold uppercase tracking-[0.2em] text-content-muted">
              Upload a spreadsheet
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xlsm,.txt,.tsv"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleFile(file)
              }}
              className="h-14 cursor-pointer border-2 border-swiss-ink bg-swiss-paper px-3 text-sm font-bold text-swiss-ink file:mr-4 file:h-full file:cursor-pointer file:border-0 file:bg-swiss-ink file:px-4 file:text-2xs file:font-bold file:uppercase file:tracking-[0.2em] file:text-swiss-paper focus:border-swiss-accent-text focus:outline-none"
            />
          </label>

          <p className="text-2xs font-medium leading-relaxed text-content-muted">
            A <strong>.csv</strong> or <strong>.xlsx</strong> file with a name and a
            SEN in any two columns. Headers are matched by name, so order does not
            matter. In Excel: Save As → CSV, or keep the .xlsx.
          </p>
        </div>

        {/* -- the preview --------------------------------------------------- */}

        {problem !== null ? (
          <p
            role="alert"
            className="border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
          >
            {problem}
          </p>
        ) : null}

        {done !== null ? (
          <p
            role="status"
            className="border-l-4 border-swiss-ink bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
          >
            {done}
          </p>
        ) : null}

        {parsed !== null ? (
          <div className="border-2 border-swiss-ink">
            <p className="border-b-2 border-swiss-ink bg-swiss-muted px-4 py-3 text-2xs font-bold uppercase tracking-[0.2em] text-swiss-ink">
              {fileName} · {parsed.rows.length} student
              {parsed.rows.length === 1 ? '' : 's'} ready
              {parsed.problems.length > 0 ? ` · ${parsed.problems.length} skipped` : ''}
            </p>

            {/*
              The first few rows, so a column picked up by position can be spotted
              BEFORE it is stored. A header the parser did not recognise is the most
              likely way to get this wrong, and it is obvious in a sample and
              invisible in a count.
            */}
            {parsed.rows.length > 0 ? (
              <ul className="flex flex-col">
                {parsed.rows.slice(0, 5).map((row) => (
                  <li
                    key={row.sen}
                    className="flex flex-wrap gap-x-4 border-b border-swiss-ink/15 px-4 py-2 font-mono text-2xs last:border-b-0"
                  >
                    <span className="text-content-muted">{row.sen}</span>
                    <span className="font-sans font-bold text-swiss-ink">{row.name}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {parsed.problems.length > 0 ? (
              <ul className="flex flex-col gap-1 border-t-2 border-swiss-ink bg-swiss-muted px-4 py-3">
                {parsed.problems.slice(0, 6).map((entry, index) => (
                  <li key={index} className="text-2xs font-medium leading-relaxed text-content-muted">
                    {entry}
                  </li>
                ))}
                {parsed.problems.length > 6 ? (
                  <li className="text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                    + {parsed.problems.length - 6} more
                  </li>
                ) : null}
              </ul>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 border-t-2 border-swiss-ink px-4 py-4">
              {/*
                Two buttons, and the destructive one is labelled with its consequence
                rather than "Upload". "Restrict registration" says what changes for
                everyone not on the list, which is the part that is hard to undo.
              */}
              <Button
                variant="primary"
                size="md"
                loading={busy}
                disabled={parsed.rows.length === 0}
                onClick={() => void commit('restricted')}
              >
                Save &amp; restrict registration
              </Button>
              <Button
                variant="secondary"
                size="md"
                disabled={busy}
                onClick={() => void commit('open')}
              >
                Save only
              </Button>
              <Button
                variant="secondary"
                size="md"
                disabled={busy}
                onClick={() => {
                  setParsed(null)
                  setFileName('')
                  if (fileRef.current) fileRef.current.value = ''
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {/* -- check the names ---------------------------------------------- */}

        {/*
          Reading the list back.

          The upload preview shows what the PARSER made of the file. This shows what
          the DATABASE ended up holding, which is a different question and the one
          that actually matters before enforcing: the row where a column shifted, the
          SEN that lost a digit, the name that became the SEN. A count cannot tell you
          any of that — only reading the rows can.

          Fetched on demand rather than with the panel. The panel header needs to know
          whether anything landed, not to hold five hundred students to say "yes, 500",
          and this response is every student's name and SEN, which has no business on a
          device that is not an owner's. That is why it is a separate owner-only route
          and not a bigger default.

          Bounded height with its own scrollbar, rather than the page growing to five
          hundred rows. The panel is one of five stacked sections on the People tab;
          a list that made the whole tab ten thousand pixels tall would push everything
          else off the screen on a phone, which is the thing this panel is trying to
          avoid.

          A filter as well as the scroll, because scrolling 500 rows to spot one
          mistake is how the mistake survives. It matches on both name and SEN so it
          can find either kind of problem, and it says how many rows survived the
          filter rather than leaving an empty-looking list ambiguous.
        */}
        {rosterCount > 0 ? (
          <div className="border-t-2 border-swiss-ink pt-4">
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => void toggleRows()}
            >
              {rowsOpen ? 'Hide the list' : `Check all ${rosterCount} names`}
            </Button>

            {rowsOpen ? (
              <div className="mt-4 flex flex-col gap-4">
                {rowsProblem !== null ? (
                  <p
                    role="alert"
                    className="border-l-4 border-swiss-accent-text bg-swiss-muted p-3 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
                  >
                    {rowsProblem}
                  </p>
                ) : null}

                {rows !== null && rows.rows.length > 0 ? (
                  <>
                    <Field
                      label="Find someone"
                      name="roster-filter"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      placeholder="Name or SEN"
                      autoComplete="off"
                    />

                    <p className="text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                      {filter.trim() === ''
                        ? `Showing all ${rows.rows.length} of ${rows.total}`
                        : `${filtered.length} of ${rows.rows.length} match`}
                    </p>

                    {/*
                      The cap made visible. A short list presented as a complete one
                      is worse than no check at all, because somebody will say they
                      have looked at every name.
                    */}
                    {rows.truncated ? (
                      <p className="border-l-4 border-swiss-accent-text bg-swiss-muted p-3 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
                        Only the first {rows.rows.length} of {rows.total} rows are
                        shown. Check the file for the rest.
                      </p>
                    ) : null}

                    <ul className="max-h-96 overflow-y-auto border-2 border-swiss-ink">
                      {filtered.map((row) => (
                        <li
                          key={row.sen}
                          className="flex flex-col gap-0.5 border-b border-swiss-ink/15 px-4 py-2 last:border-b-0"
                        >
                          <span className="text-sm font-bold text-swiss-ink">
                            {row.name}
                          </span>
                          <span className="font-mono text-2xs text-content-muted">
                            {row.sen}
                          </span>
                        </li>
                      ))}
                      {filtered.length === 0 ? (
                        <li className="px-4 py-4 text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
                          Nobody matches that
                        </li>
                      ) : null}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* -- clear --------------------------------------------------------- */}

        {rosterCount > 0 ? (
          <div className="border-t-2 border-swiss-ink pt-4">
            <Button variant="secondary" size="md" disabled={busy} onClick={() => void clear()}>
              Clear the list
            </Button>
            <p className="mt-2 text-2xs font-medium leading-relaxed text-content-muted">
              Empties the list. The file you uploaded is not kept. This does{' '}
              <strong>not</strong> change who may register — that is the switch
              above.
            </p>

            {/*
              The one state where clearing leaves the door shut with nobody behind
              it. Stated before the click as well as after, because this is the
              sequence that would otherwise look like a bug: somebody opens
              registration to the list, then decides the list was wrong.
            */}
            {mode === 'restricted' ? (
              <div className="mt-4 flex flex-col items-start gap-3 border-l-4 border-swiss-accent-text bg-swiss-muted p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink">
                  Registration is set to the guest list. Clearing it leaves nobody
                  able to register.
                </p>
                <Button
                  variant="primary"
                  size="md"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await portalApi.setRegistrationMode('open')
                      onModeChange('open')
                    } catch (error) {
                      setProblem(error instanceof Error ? error.message : 'Could not open registration.')
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  Open to anyone instead
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}