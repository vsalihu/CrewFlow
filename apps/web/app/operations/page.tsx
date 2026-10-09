import Link from 'next/link';
import { operationalDates, operationsBoard, referenceData } from '@cds/domain';
import { AutoRefresh } from '@/components/AutoRefresh';
import { StateBadge } from '@/components/Status';
import { TaskList } from '@/components/TaskList';
import { Badge, Empty, Flash, LinkButton, Panel, Stat, td, th } from '@/components/ui';
import { fmtDate, fmtTime } from '@/lib/format';
import { requireContext } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function OperationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const ref = await referenceData(ctx);
  const branchId = sp.branch ?? ref.branches[0]?.id;
  if (!branchId) return <Empty>You are not a member of any branch yet. Ask a branch manager to add you.</Empty>;
  const { today, tomorrow } = operationalDates(new Date());
  const day = sp.day === 'tomorrow' ? 'tomorrow' : sp.day === 'date' && sp.date ? 'date' : 'today';
  const date = day === 'tomorrow' ? tomorrow : day === 'date' ? sp.date! : today;
  const data = await operationsBoard(ctx, { branchId, date });
  const c = data.counts;
  const q = (extra: Record<string, string>) => `/operations?${new URLSearchParams({ branch: branchId, ...extra }).toString()}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Operations</h1>
        <nav aria-label="Day" className="flex rounded-[var(--radius-ui)] border border-hairline-strong bg-surface p-0.5 text-sm">
          {(['today', 'tomorrow'] as const).map((d) => (
            <Link key={d} href={q({ day: d })} aria-current={day === d ? 'page' : undefined} className={`rounded px-3 py-1 capitalize ${day === d ? 'bg-accent text-on-accent' : 'text-ink-muted hover:bg-surface-2'}`}>
              {d}
            </Link>
          ))}
        </nav>
        <form className="flex items-center gap-2 text-sm" action="/operations">
          <input type="hidden" name="branch" value={branchId} />
          <input type="hidden" name="day" value="date" />
          <label htmlFor="date" className="sr-only">
            Date
          </label>
          <input key={date} id="date" name="date" type="date" defaultValue={date} className="h-8 rounded-[var(--radius-ui)] border border-hairline-strong bg-surface px-2" />
          <button className="h-8 rounded-[var(--radius-ui)] border border-hairline-strong bg-surface px-3 hover:bg-surface-2">Go</button>
        </form>
        {ref.branches.length > 1 ? (
          <nav aria-label="Branch" className="flex gap-1 text-sm">
            {ref.branches.map((b) => (
              <Link key={b.id} href={`/operations?${new URLSearchParams({ branch: b.id, day }).toString()}`} aria-current={b.id === branchId ? 'page' : undefined} className={`rounded px-2 py-1 ${b.id === branchId ? 'bg-surface-2 font-medium' : 'text-ink-muted hover:bg-surface-2'}`}>
                {b.name}
              </Link>
            ))}
          </nav>
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          <AutoRefresh generatedAt={data.generatedAt.toISOString()} />
          <LinkButton href="/orders/new" variant="primary">
            New Order
          </LinkButton>
        </div>
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      <p className="text-sm text-ink-muted">{fmtDate(date)}</p>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-[var(--radius-ui)] border border-hairline bg-surface p-4 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="Requested" value={c.requested} />
        <Stat label="Accepted" value={c.accepted} />
        <Stat label="Confirmed" value={c.confirmed} tone={c.confirmed < c.accepted ? 'warn' : 'ok'} />
        <Stat label="Uncovered slots" value={c.uncoveredSlots} tone={c.uncoveredSlots ? 'bad' : 'ok'} />
        <Stat label="Transport legs unresolved" value={c.unresolvedTransportLegs} tone={c.unresolvedTransportLegs ? 'bad' : 'ok'} />
        <Stat label="JoinedUp unverified" value={c.unverifiedExternal} tone={c.unverifiedExternal ? 'warn' : 'ok'} />
        <Stat label="Open conflicts" value={c.openConflicts} tone={c.openConflicts ? 'bad' : 'ok'} />
        <Stat label="Urgent tasks" value={c.urgentTasks} tone={c.urgentTasks ? 'bad' : 'ok'} />
      </div>
      {c.coverageAlerts ? (
        <div role="alert" className="rounded-[var(--radius-ui)] bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
          {c.coverageAlerts} urgent item(s) have no one on duty to own them. Assign an owner now.
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Panel title={`Orders (${data.board.length} shift line${data.board.length === 1 ? '' : 's'})`}>
          {data.board.length ? (
            <div className="-m-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={th}>Arrive / start</th>
                    <th className={th}>Order</th>
                    <th className={th}>Client, site, role</th>
                    <th className={`${th} text-right`}>Req / Acc / Conf / Arr</th>
                    <th className={th}>Status</th>
                    <th className={th}>Next action</th>
                    <th className={th}>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {data.board.map((r) => (
                    <tr key={r.lineId} className="hover:bg-surface-2">
                      <td className={`${td} num whitespace-nowrap`}>
                        {fmtTime(r.arrivalAt)} / {fmtTime(r.startAt)}
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        <Link href={`/orders/${r.orderId}`} className="font-mono text-accent hover:underline">
                          {r.reference}-{r.lineNo}
                        </Link>
                        {r.urgency !== 'normal' ? (
                          <span className="ml-1.5">
                            <StateBadge state={r.urgency} />
                          </span>
                        ) : null}
                      </td>
                      <td className={`${td} min-w-48`}>
                        <div className="font-medium">{r.clientName}</div>
                        <div className="text-xs text-ink-subtle">
                          {r.siteName ?? 'Site not confirmed'} · {r.role ?? 'Role not set'}
                          {r.teamLabel ? ` · ${r.teamLabel}` : ''}
                        </div>
                      </td>
                      <td className={`${td} num whitespace-nowrap text-right`}>
                        {r.status.requested} / {r.status.accepted ?? '?'} / {r.status.confirmed} / {r.status.arrived}
                      </td>
                      <td className={td}>
                        <div className="flex flex-wrap gap-1">
                          <StateBadge state={r.status.staffing} />
                          {r.status.transportUnresolvedLegs ? <Badge tone="bad">transport {r.status.transportUnresolvedLegs}</Badge> : null}
                          {r.status.openConflicts ? <Badge tone="bad">conflict</Badge> : null}
                          {r.status.externalPending ? <Badge tone="warn">JU {r.status.externalPending}</Badge> : null}
                          {r.status.ready ? <Badge tone="ok">ready</Badge> : null}
                        </div>
                      </td>
                      <td className={`${td} min-w-56 text-ink-muted`}>{r.nextAction}</td>
                      <td className={`${td} whitespace-nowrap text-ink-muted`}>{r.ownerName ?? 'Unowned'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No orders for this day. Client silence is not an order and not a cancellation.</Empty>
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={`Return queue (${data.returnQueue.length})`}>
            {data.returnQueue.length ? (
              <ul className="flex flex-col gap-2 text-sm">
                {data.returnQueue.map((r) => (
                  <li key={r.assignmentId} className="flex flex-col">
                    <span className="font-medium">
                      {r.workerName} <span className="font-mono text-xs text-ink-subtle">{r.reference}</span>
                    </span>
                    <span className="text-xs text-ink-subtle">
                      {r.accountable ? `Dispatcher: ${r.accountable}` : 'No dispatcher accountable'}
                      {r.note ? ` · ${r.note}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No unresolved return journeys.</Empty>
            )}
          </Panel>
          <Panel title={`Open tasks (${data.tasks.length})`}>
            <TaskList tasks={data.tasks} back={q({ day })} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
