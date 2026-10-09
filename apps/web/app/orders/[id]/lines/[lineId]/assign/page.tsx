import Link from 'next/link';
import { getOrderDetail, listCandidates } from '@cds/domain';
import { Badge, Button, Empty, Flash, Panel, inputClass, td, th } from '@/components/ui';
import { fmtDate, fmtTime } from '@/lib/format';
import { requireContext } from '@/lib/session';
import { proposeWorkersAction } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function AssignPage({ params, searchParams }: { params: Promise<{ id: string; lineId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const { id, lineId } = await params;
  const sp = await searchParams;
  const order = await getOrderDetail(ctx, id);
  const line = order.lines.find((x) => x.l.id === lineId);
  if (!line) return <Empty>Line not found.</Empty>;
  const candidates = await listCandidates(ctx, lineId, { search: sp.q });
  const free = line.l.acceptedCount === null ? 0 : Math.max(0, line.l.acceptedCount - line.status.confirmed - line.status.proposed - line.status.reconfirmationRequired);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/orders/${id}`} className="text-sm text-accent hover:underline">
          ← {order.order.reference}
        </Link>
        <h1 className="text-lg font-semibold">
          Assign workers: line {line.l.lineNo}, {line.l.role ?? 'role not set'}
        </h1>
      </div>
      <p className="text-sm text-ink-muted">
        {fmtDate(line.l.serviceDate)} · {line.siteName ?? 'site not confirmed'} · arrive {fmtTime(line.l.arrivalAt)} · {line.l.acceptedCount === null ? 'agency has not accepted a quantity yet' : `${free} place(s) free of ${line.l.acceptedCount} accepted`}
      </p>
      <Flash error={sp.error} notice={sp.notice} />
      <form className="flex max-w-md gap-2" action={`/orders/${id}/lines/${lineId}/assign`}>
        <label htmlFor="q" className="sr-only">
          Search
        </label>
        <input id="q" name="q" defaultValue={sp.q ?? ''} placeholder="Name, alias or JoinedUp ID…" autoComplete="off" spellCheck={false} className={inputClass} />
        <Button type="submit">Search</Button>
      </form>
      <Panel title={`Candidates (${candidates.filter((c) => c.eligible).length} eligible of ${candidates.length})`}>
        <form action={proposeWorkersAction} className="flex flex-col gap-3">
          <input type="hidden" name="orderId" value={id} />
          <input type="hidden" name="lineId" value={lineId} />
          <p className="text-sm text-ink-muted">You choose. Exclusions are explained; there is no hidden ranking. Proposing reserves the worker&apos;s time but is not their agreement.</p>
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>
                    <span className="sr-only">Select</span>
                  </th>
                  <th className={th}>Worker</th>
                  <th className={th}>JoinedUp ID</th>
                  <th className={th}>Why / why not</th>
                  <th className={th}>Roster transport label (kept as written)</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.workerId} className={c.eligible ? '' : 'text-ink-subtle'}>
                    <td className={td}>
                      <input type="checkbox" name="workerId" value={c.workerId} disabled={!c.eligible} aria-label={`Select ${c.displayName}`} />
                    </td>
                    <td className={`${td} font-medium`}>{c.displayName}</td>
                    <td className={`${td} font-mono num`} translate="no">
                      {c.externalIds.join(', ') || 'none'}
                    </td>
                    <td className={td}>
                      <div className="flex flex-col gap-1">
                        {c.exclusions.map((e, i) => (
                          <span key={i}>
                            <Badge tone="bad">excluded</Badge> {e.message}
                          </span>
                        ))}
                        {c.warnings.map((w, i) => (
                          <span key={i}>
                            <Badge tone="warn">check</Badge> {w}
                          </span>
                        ))}
                        {c.notes.map((n, i) => (
                          <span key={i} className="text-xs">
                            {n}
                          </span>
                        ))}
                        {c.eligible && !c.warnings.length && !c.notes.length ? <span className="text-xs">No issues found.</span> : null}
                      </div>
                    </td>
                    <td className={td}>
                      <label className="sr-only" htmlFor={`label-${c.workerId}`}>
                        Transport label for {c.displayName}
                      </label>
                      <input id={`label-${c.workerId}`} name={`label_${c.workerId}`} disabled={!c.eligible} placeholder="e.g. OWN…" autoComplete="off" className={`${inputClass} max-w-32`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {candidates.length ? null : <Empty>No workers match.</Empty>}
          <Button variant="primary" type="submit" className="self-start">
            Propose Selected
          </Button>
        </form>
      </Panel>
    </div>
  );
}
