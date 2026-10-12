import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/Button'
import { Skeleton } from '@/components/Skeleton'
import { portalApi } from '@/api'
import type { Team, TeamPassReport } from '@/domain/types'

/**
 * How often this panel re-reads the team list while it is on screen.
 *
 * Five seconds, and it only runs while the tab is visible and the browser window
 * has focus.
 *
 * FIVE SECONDS IS THE PRODUCT DECISION. The requirement is that a team shows up
 * "immediately, without refreshing manually", and during a challenge brief the
 * organiser's laptop is on the table next to the form — a laptop sitting open on a
 * table at a venue is the one device that can be left on all day, and a
 * fifteen-second poll is a visible lag.
 *
 * `document.hidden` GATES IT, and that is the whole trick behind "without
 * refreshing". An admin tab left in the background on a battery would otherwise
 * keep hitting the database every five seconds for eight hours, which is the kind
 * of thing that is fine on a laptop nobody is looking at and terrible on the
 * conference-room screen somebody left running. Paused while hidden, resumed with
 * an immediate read when it comes back — so what is on screen after a tab switch is
 * current, not three minutes old.
 *
 * WHY POLLING AND NOT A WEBSOCKET
 *
 * A websocket is the right tool for a wallboard in a hall. This is a laptop on a
 * table with a VPN that drops between the phone hotspot and the venue wifi, and a
 * dropped socket on an unreliable network is a list that silently stops updating —
 * which looks exactly like "no teams registered yet". Polling fails visibly and
 * recovers by itself, and the cost is one small query every five seconds.
 */
const POLL_MS = 5_000

/**
 * A row's identity, for deciding whether anything actually changed.
 *
 * Comparing a signature rather than re-rendering on every poll: a component that
 * re-renders every five seconds restarts CSS animations and pushes a caret out of
 * a field if somebody is mid-copy. This panel has no inputs, but the same argument
 * applies to a row the organiser is in the middle of reading, and a list that
 * visibly flickers is one nobody trusts.
 */
function signature(teams: readonly Team[]): string {
  return teams.map((t) => `${t.id}:${t.passSentAt ?? ''}`).join('|')
}

export function TeamsPanel() {
  const [teams, setTeams] = useState<readonly Team[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [report, setReport] = useState<TeamPassReport | null>(null)

  /*
    `signatureRef` holds the last rendered list's shape. Written in the read and
    read in the setter, so a poll that returns the same teams does not touch
    React state at all.
  */
  const signatureRef = useRef('')

  const read = useCallback(async () => {
    try {
      const next = await portalApi.listTeams()
      const nextSignature = signature(next)

      if (nextSignature !== signatureRef.current) {
        signatureRef.current = nextSignature
        setTeams(next)
      }

      setError(null)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The team list could not be loaded.',
      )
    } finally {
      // Set even on failure: a first load that throws has still told us there is
      // nothing more to wait for, and leaving this false would leave a skeleton on
      // screen forever with the error underneath it.
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void read()

    let timer: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (timer !== null) return
      timer = setInterval(() => {
        if (!document.hidden) void read()
      }, POLL_MS)
    }

    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }

    const onVisibility = () => {
      if (document.hidden) {
        stop()
        return
      }
      // An immediate read on return, so what appears is now rather than in up to
      // five seconds' time. This is the moment the organiser comes back to the
      // laptop, and it is the moment the list most needs to be right.
      void read()
      start()
    }

    start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [read])

  const sendPasses = useCallback(async () => {
    setSending(true)
    setReport(null)
    try {
      const result = await portalApi.emailTeamPasses()
      setReport(result)
      await read()
    } catch (cause) {
      setReport({
        configured: true,
        total: teams.length,
        sent: 0,
        failures: [],
        message:
          cause instanceof Error ? cause.message : 'The passes could not be emailed.',
      })
    } finally {
      setSending(false)
    }
  }, [read, teams.length])

  const awaiting = teams.filter((team) => team.passSentAt === null).length

  return (
    <section aria-labelledby="teams-heading" className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 border-b-2 border-swiss-ink pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="flex items-center gap-3 text-2xs font-bold uppercase tracking-[0.25em] text-swiss-accent-text">
            <span aria-hidden="true" className="h-[3px] w-12 bg-swiss-accent-text" />
            Challenge
          </p>
          <h2
            id="teams-heading"
            className="mt-3 text-[clamp(1.5rem,5vw,2.25rem)] font-black uppercase leading-[0.9] tracking-tighter text-swiss-ink"
          >
            Teams
          </h2>
        </div>

        <div className="flex flex-col items-start gap-2 sm:items-end">
          <Button variant="accent" onClick={() => void sendPasses()} loading={sending}>
            {sending ? 'Emailing' : 'Email passes to leaders'}
          </Button>
          {/*
            The count of who has NOT had theirs, above the button rather than after
            it: it is what the button is about to do, and an organiser reading
            "12 teams" and then "12 sent" after pressing it deserves to have been
            warned first.
          */}
          {loaded && teams.length > 0 ? (
            <p className="text-2xs font-medium uppercase tracking-[0.15em] text-content-muted">
              {teams.length} registered · {awaiting} awaiting a pass
            </p>
          ) : null}
        </div>
      </header>

      {/*
        The report is `role="status"`, not `role="alert"`. This is the answer to a
        button the owner pressed, not an emergency, and an assertive region would
        interrupt a screen reader mid-sentence elsewhere in the portal.
      */}
      {report !== null ? (
        <div
          role="status"
          className={`border-l-4 p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] ${
            report.sent > 0 && report.failures.length === 0
              ? 'border-swiss-ink bg-swiss-muted text-swiss-ink'
              : 'border-swiss-accent-text bg-swiss-muted text-swiss-ink'
          }`}
        >
          <p>{report.message}</p>

          {!report.configured ? (
            <p className="mt-2 font-medium normal-case tracking-normal text-content-muted">
              Nothing was delivered, because no email service is configured on this
              deployment. Set the provider key and the sending domain, then press it
              again — nothing is lost by re-sending.
            </p>
          ) : null}

          {report.failures.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1 font-medium normal-case tracking-normal text-content-muted">
              {report.failures.map((failure) => (
                <li key={failure.team}>
                  <span className="font-bold text-swiss-ink">{failure.team}</span> —{' '}
                  {failure.leader}: {failure.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {error !== null ? (
        <p
          role="alert"
          className="border-l-4 border-swiss-accent-text bg-swiss-muted p-4 text-2xs font-bold uppercase leading-relaxed tracking-[0.15em] text-swiss-ink"
        >
          {error}
        </p>
      ) : null}

      {!loaded ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : teams.length === 0 ? (
        /*
          EMPTY IS A REAL STATE AND IT IS NOT A FAULT.

          Before the first team registers this panel says so in plain words and
          names where the form is. An empty table with no explanation reads as a
          broken page, and an organiser who thinks it is broken will not press the
          email button when a team does arrive.
        */
        <p className="border-l-4 border-swiss-ink bg-swiss-muted p-5 text-sm font-medium leading-relaxed text-swiss-ink">
          No teams yet. They appear here the moment somebody registers at{' '}
          <span className="font-mono">/team</span> — this list updates itself.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {teams.map((team) => (
            <li
              key={team.id}
              className="border-2 border-swiss-ink"
            >
              <div className="flex flex-col gap-3 border-b-2 border-swiss-ink bg-swiss-ink px-5 py-3 sm:flex-row sm:items-baseline sm:justify-between">
                <h3 className="text-lg font-black uppercase leading-none tracking-tighter text-swiss-paper">
                  {team.name}
                </h3>
                <p className="shrink-0 font-mono text-2xs font-bold tracking-[0.2em] text-swiss-paper/70">
                  {team.passSentAt === null ? 'NO PASS SENT' : 'PASS SENT'}
                </p>
              </div>

              <div className="grid grid-cols-1 gap-px bg-swiss-ink sm:grid-cols-3">
                {[
                  ['Leader', team.leaderName],
                  ['Email', team.leaderEmail],
                  ['Phone', team.leaderPhone],
                ].map(([term, value]) => (
                  <div key={term} className="bg-swiss-muted px-4 py-3">
                    <p className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
                      {term}
                    </p>
                    <p className="mt-1 break-words font-mono text-sm font-bold tracking-tight text-swiss-ink">
                      {value}
                    </p>
                  </div>
                ))}
              </div>

              <ol className="flex flex-col">
                {team.members.map((member) => (
                  <li
                    key={member.sen}
                    className="flex flex-col gap-1 border-t border-swiss-ink/15 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
                  >
                    <div>
                      <p className="text-sm font-black tracking-tight text-swiss-ink">
                        {member.name}
                      </p>
                      {member.isLeader ? (
                        <p className="mt-0.5 text-2xs font-bold uppercase tracking-[0.15em] text-swiss-accent-text">
                          Team leader
                        </p>
                      ) : null}
                    </div>
                    <p className="font-mono text-sm tracking-tight text-swiss-ink">
                      {member.sen}
                    </p>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
