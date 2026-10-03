import QRCode from 'react-qr-code'
import type { Ticket } from '@/domain/types'
import { formatPhone } from '@/domain/phone'
import type { Attendee } from '@/domain/types'
import { Skeleton } from './Skeleton'

/**
 * The entry pass.
 *
 * The QR encodes a signed, single-use URL. Presenting it at the gate lets
 * staff check someone in, and the signature means a screenshot cannot be
 * reused by anyone else.
 */
export function QrTicket({
  ticket,
  attendee,
  loading,
}: {
  ticket: Ticket | null
  attendee: Attendee | null
  loading: boolean
}) {
  return (
    <section
      aria-labelledby="pass-heading"
      className="flex flex-col border-2 border-swiss-ink bg-swiss-paper"
    >
      <header className="flex items-baseline justify-between gap-3 border-b-2 border-swiss-ink bg-swiss-ink px-6 py-3">
        <h2
          id="pass-heading"
          className="text-2xs font-bold uppercase tracking-[0.25em] text-swiss-paper"
        >
          Your Entry Pass
        </h2>
        <span className="text-2xs font-bold uppercase tracking-[0.2em] text-swiss-accent-on-dark">
          Admit One
        </span>
      </header>

      <div className="flex flex-1 flex-col items-center gap-6 p-6">
        {loading ? (
          <Skeleton className="aspect-square w-full max-w-[13rem]" />
        ) : ticket ? (
          <>
            {/* Fixed square with generous quiet zone: printed codes need it,
                and it keeps the panel from reflowing as the ticket loads.
                `motion-scale-in` marks the moment the pass actually exists —
                the thing an attendee opened the page for. Scale is safe here
                because the box is already at its final size; only opacity and a
                3% transform move, so the code's geometry never shifts. */}
            <div className="motion-scale-in w-full max-w-[13rem] border-2 border-swiss-ink p-3">
              <QRCode
                value={ticket.encoded}
                size={1000}
                level="M"
                bgColor="#ffffff"
                fgColor="#000000"
                style={{ height: 'auto', maxWidth: '100%', width: '100%' }}
              />
            </div>

            <p className="text-center text-2xs font-medium leading-relaxed text-content-muted">
              Scanned once at the gate to mark your attendance.
            </p>
          </>
        ) : (
          <p
            role="status"
            className="py-12 text-center text-2xs font-bold uppercase tracking-[0.2em] text-swiss-accent-text"
          >
            Pass unavailable
          </p>
        )}
      </div>

      {/* Identity block: the human-readable half of the pass. */}
      {attendee ? (
        <dl className="grid grid-cols-1 gap-px border-t-2 border-swiss-ink bg-swiss-ink sm:grid-cols-2">
          <div className="bg-swiss-muted p-4">
            <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
              Name
            </dt>
            <dd className="mt-1 break-words text-sm font-black tracking-tight text-swiss-ink">
              {attendee.name}
            </dd>
          </div>
          <div className="bg-swiss-muted p-4">
            <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
              Phone
            </dt>
            <dd className="mt-1 font-mono text-sm font-bold text-swiss-ink">
              {formatPhone(attendee.phone)}
            </dd>
          </div>
          <div className="bg-swiss-muted p-4">
            <dt className="text-2xs font-medium uppercase tracking-[0.2em] text-content-muted">
              SEN
            </dt>
            <dd className="mt-1 font-mono text-sm font-bold text-swiss-ink">
              {attendee.sen}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  )
}
