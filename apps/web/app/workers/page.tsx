import Link from 'next/link';
import { searchWorkers } from '@cds/domain';
import { StateBadge } from '@/components/Status';
import { Badge, Button, Empty, Panel, inputClass, td, th } from '@/components/ui';
import { fmtDate, label } from '@/lib/format';
import { requireContext } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function WorkersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const rows = await searchWorkers(ctx, sp.q ?? '');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Workers</h1>
      <form className="flex max-w-md gap-2" action="/workers">
        <label htmlFor="q" className="sr-only">
          Search
        </label>
        <input id="q" name="q" defaultValue={sp.q ?? ''} placeholder="Name, alias or exact JoinedUp ID…" spellCheck={false} autoComplete="off" className={inputClass} />
        <Button type="submit">Search</Button>
      </form>
      <Panel title={`${rows.length} worker(s)`}>
        {rows.length ? (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>External IDs</th>
                  <th className={th}>Skills</th>
                  <th className={th}>Readiness</th>
                  <th className={th}>Upcoming</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.worker.id}>
                    <td className={td}>
                      <div className="font-medium">{r.worker.displayName}</div>
                      {r.aliases.length ? <div className="text-xs text-ink-subtle">Also: {r.aliases.map((a) => a.alias).join(', ')}</div> : null}
                      <div className="mt-1 flex gap-1">
                        {r.isDriver ? <Badge tone="info">explicit driver</Badge> : null}
                        {r.worker.latestFinishLocal ? <Badge tone="warn">leaves by {r.worker.latestFinishLocal.slice(0, 5)}</Badge> : null}
                        {r.worker.status !== 'active' ? <StateBadge state={r.worker.status} /> : null}
                      </div>
                    </td>
                    <td className={`${td} font-mono num text-xs`} translate="no">
                      {r.externalIds.map((e) => `${e.provider}: ${e.externalId}`).join(', ') || 'none'}
                    </td>
                    <td className={`${td} text-xs`}>{r.skills.map((s) => `${s.skill}${s.expiresOn ? ` (to ${s.expiresOn})` : ''}`).join(', ') || 'none recorded'}</td>
                    <td className={td}>{r.readinessBlocking ? <Badge tone="bad">{r.readinessBlocking}</Badge> : <Badge tone="ok">cleared</Badge>}</td>
                    <td className={`${td} text-xs`}>
                      {r.upcoming.length
                        ? r.upcoming.map((u, i) => (
                            <div key={i}>
                              <Link href={`/orders/${u.orderId}`} className="font-mono text-accent hover:underline">
                                {u.reference}
                              </Link>{' '}
                              {fmtDate(u.date)} ({label(u.state)})
                            </div>
                          ))
                        : 'none'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No workers match.</Empty>
        )}
      </Panel>
    </div>
  );
}
