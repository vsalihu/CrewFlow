import { listExternalBookingQueue, referenceData } from '@cds/domain';
import { StateBadge } from '@/components/Status';
import { Badge, Empty, Flash, Panel, td, th } from '@/components/ui';
import { fmtDate, fmtTime } from '@/lib/format';
import { requireContext } from '@/lib/session';
import { externalBookingAction } from '../actions';

export const dynamic = 'force-dynamic';

const small = 'h-7 rounded border border-hairline-strong bg-surface px-1 text-xs';

export default async function JoinedUpPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const ref = await referenceData(ctx);
  const branchId = sp.branch ?? ref.branches[0]?.id;
  if (!branchId) return <Empty>No branch access.</Empty>;
  const queue = await listExternalBookingQueue(ctx, branchId);
  const pending = queue.filter((q) => q.booking.state !== 'verified' || q.outOfDate);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold">JoinedUp Queue</h1>
        <p className="text-sm text-ink-subtle">
          JoinedUp stays the system of record. Enter each booking there, record its ID, then verify it against JoinedUp.
        </p>
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      <Panel title={`Needs action (${pending.length} of ${queue.length})`}>
        {queue.length ? (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Worker</th>
                  <th className={th}>JoinedUp worker ID</th>
                  <th className={th}>Shift</th>
                  <th className={th}>State</th>
                  <th className={th}>Record</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q) => (
                  <tr key={q.booking.id}>
                    <td className={`${td} font-medium`}>{q.workerName}</td>
                    <td className={`${td} font-mono num`} translate="no">
                      {q.joinedUpWorkerId ?? 'none'}
                    </td>
                    <td className={`${td} text-xs`}>
                      <span className="font-mono">
                        {q.reference}-{q.lineNo}
                      </span>{' '}
                      {fmtDate(q.serviceDate)} {fmtTime(q.startAt)} · {q.siteName ?? 'site not confirmed'}
                    </td>
                    <td className={td}>
                      <div className="flex flex-col gap-1">
                        <StateBadge state={q.booking.state} />
                        {q.outOfDate ? <Badge tone="bad">shift changed since entry</Badge> : null}
                        {q.booking.externalBookingId ? <span className="font-mono text-xs">{q.booking.externalBookingId}</span> : null}
                      </div>
                    </td>
                    <td className={td}>
                      <form action={externalBookingAction} className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="id" value={q.booking.id} />
                        <input type="hidden" name="version" value={q.booking.version} />
                        <label className="sr-only" htmlFor={`act-${q.booking.id}`}>
                          Action
                        </label>
                        <select
                          id={`act-${q.booking.id}`}
                          name="action"
                          defaultValue={q.booking.state === 'pending_entry' ? 'entered' : 'verified'}
                          className={small}
                        >
                          <option value="entered">Entered in JoinedUp</option>
                          <option value="verified">Verified in JoinedUp</option>
                          <option value="discrepancy">Discrepancy</option>
                          <option value="failed">Could not enter</option>
                        </select>
                        <label className="sr-only" htmlFor={`ext-${q.booking.id}`}>
                          JoinedUp booking ID
                        </label>
                        <input
                          id={`ext-${q.booking.id}`}
                          name="externalBookingId"
                          defaultValue={q.booking.externalBookingId ?? ''}
                          placeholder="Booking ID…"
                          spellCheck={false}
                          autoComplete="off"
                          className={`${small} w-28 font-mono`}
                        />
                        <label className="sr-only" htmlFor={`ev-${q.booking.id}`}>
                          Evidence
                        </label>
                        <input id={`ev-${q.booking.id}`} name="evidenceNote" placeholder="What you checked…" className={`${small} w-40`} />
                        <button className="h-7 rounded border border-hairline-strong px-2 text-xs hover:bg-surface-2">Save</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No bookings waiting. Bookings appear here when a worker confirms a shift for a client that uses JoinedUp.</Empty>
        )}
      </Panel>
    </div>
  );
}
