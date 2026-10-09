import { listHandovers, myOpenTasks, referenceData } from '@cds/domain';
import { TaskList } from '@/components/TaskList';
import { Badge, Button, Empty, Field, Flash, Panel, inputClass } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { requireContext } from '@/lib/session';
import { acknowledgeHandoverAction, createHandoverAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function HandoverPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const ref = await referenceData(ctx);
  const branchId = sp.branch ?? ref.branches[0]?.id;
  if (!branchId) return <Empty>No branch access.</Empty>;
  const me = ctx.actor.kind === 'staff' ? ctx.actor.membershipId : null;
  const [handovers, tasks] = await Promise.all([listHandovers(ctx, branchId), myOpenTasks(ctx, branchId)]);
  const colleagues = ref.staff.filter((s) => s.branchId === branchId && s.id !== me);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Handover</h1>
      <Flash error={sp.error} notice={sp.notice} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Hand over my open work">
          <form action={createHandoverAction} className="flex flex-col gap-3">
            <input type="hidden" name="branchId" value={branchId} />
            <p className="text-sm text-ink-muted">Saves a time-stamped snapshot and moves your open tasks (and any unowned ones) to the incoming person, who must acknowledge.</p>
            <Field label="Hand over to" htmlFor="incoming">
              <select id="incoming" name="incomingMembershipId" required className={inputClass}>
                {colleagues.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Note" htmlFor="note">
              <input id="note" name="note" placeholder="Anything not captured in a task…" className={inputClass} />
            </Field>
            <Button variant="primary" type="submit" className="self-start">
              Hand Over
            </Button>
          </form>
        </Panel>
        <Panel title="Recent handovers">
          {handovers.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {handovers.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {h.outgoingName} → {h.incomingName}, {h.taskIds.length} task(s), {fmtDateTime(h.asOf)}
                  </span>
                  {h.acknowledgedAt ? (
                    <Badge tone="ok">acknowledged {fmtDateTime(h.acknowledgedAt)}</Badge>
                  ) : h.incomingMembershipId === me ? (
                    <form action={acknowledgeHandoverAction}>
                      <input type="hidden" name="handoverId" value={h.id} />
                      <Button variant="primary" type="submit">
                        Acknowledge
                      </Button>
                    </form>
                  ) : (
                    <Badge tone="warn">not acknowledged</Badge>
                  )}
                  {h.note ? <span className="w-full text-xs text-ink-subtle">{h.note}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No handovers yet.</Empty>
          )}
        </Panel>
      </div>
      <Panel title={`Open tasks in this branch (${tasks.length})`}>
        <TaskList tasks={tasks.map((t) => ({ ...t.t, ownerName: t.ownerName }))} back="/handover" />
      </Panel>
    </div>
  );
}
