import Link from 'next/link';
import { can } from '@cds/auth';
import { getTimesheet, timesheetWorkerOptions } from '@cds/domain';
import { StateBadge } from '@/components/Status';
import { Badge, Button, Empty, Field, Flash, Panel, inputClass, td, th } from '@/components/ui';
import { fmtDate, fmtDateTime, label } from '@/lib/format';
import { orNotFound, requireContext } from '@/lib/session';
import { approveTimesheetAction, correctSegmentAction, disputeTimesheetAction, voidSegmentAction } from '../../../actions';

export const dynamic = 'force-dynamic';

const minutes = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const small = 'h-7 min-w-0 rounded border border-hairline-strong bg-surface px-1 text-xs';

export default async function TimesheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireContext();
  const { id } = await params;
  const sp = await searchParams;
  const t = await orNotFound(getTimesheet(ctx, id));
  const b = t.b;
  const workers = await timesheetWorkerOptions(ctx, { branchId: b.branchId, date: b.serviceDate });
  const current = t.segments.filter((s) => s.s.isCurrent);
  const history = t.segments.filter((s) => !s.s.isCurrent);
  const me = ctx.actor.kind === 'staff' ? ctx.actor.membershipId : null;
  const mayApprove = can(ctx.actor, 'attendance.approve', b.branchId) && b.recordedBy !== me;
  const blocking = t.discrepancies.filter((d) => d.severity === 'block');
  const review = t.discrepancies.filter((d) => d.severity === 'review');
  const info = t.discrepancies.filter((d) => d.severity === 'info');
  const totalPaid = current.filter((s) => s.s.status === 'active').reduce((n, s) => n + s.s.paidMinutes, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={`/attendance?${new URLSearchParams({ branch: b.branchId, date: b.serviceDate }).toString()}`}
          className="text-sm text-accent hover:underline"
        >
          ← Attendance
        </Link>
        <h1 className="font-mono text-lg font-semibold">{b.reference}</h1>
        <StateBadge state={b.state} />
        <span className="text-sm text-ink-muted">
          {t.clientName} · {t.siteName} · {fmtDate(b.serviceDate)} · from {b.supervisorName}
        </span>
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      {b.state === 'disputed' && b.disputeNote ? <Flash error={`Disputed: ${b.disputeNote}`} /> : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={`Checks (${t.discrepancies.length})`}>
            {t.discrepancies.length ? (
              <ul className="flex flex-col gap-1.5 text-sm">
                {[...blocking, ...review, ...info].map((d, i) => (
                  <li key={i}>
                    <Badge tone={d.severity === 'block' ? 'bad' : d.severity === 'review' ? 'warn' : 'info'}>
                      {d.severity === 'block' ? 'blocks approval' : d.severity === 'review' ? 'needs justification' : 'follow up'}
                    </Badge>{' '}
                    {d.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ok">Matches the bookings, other timesheets, readiness and the break rule.</p>
            )}
          </Panel>

          <Panel title={`Entries (${current.length}), ${minutes(totalPaid)} paid`}>
            <p className="mb-3 text-xs text-ink-subtle">
              Break rule:{' '}
              {t.policy
                ? `v${t.policy.policyVersion}, ${t.policy.unpaidBreakMinutes} min unpaid after ${minutes(t.policy.unpaidAfterMinutes)}, ${t.policy.paidBreakMinutes} min paid (${t.policy.agreementReference})`
                : 'none agreed for this client; unpaid breaks are entered as written'}
            </p>
            <div className="-mx-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={th}>As written</th>
                    <th className={th}>Worker</th>
                    <th className={th}>Times</th>
                    <th className={`${th} text-right`}>Unpaid / paid break</th>
                    <th className={`${th} text-right`}>Paid</th>
                    <th className={th}>Revision</th>
                    <th className={th}>Correct or void</th>
                  </tr>
                </thead>
                <tbody>
                  {current.map(({ s, workerName, exports }) => (
                    <tr key={s.id} className={s.status === 'voided' ? 'text-ink-subtle line-through' : ''}>
                      <td className={td}>{s.rawName}</td>
                      <td className={td}>{workerName ?? <Badge tone="bad">not identified</Badge>}</td>
                      <td className={`${td} num whitespace-nowrap`}>
                        {s.startLocal.slice(0, 5)}–{s.endLocal.slice(0, 5)}
                        {s.endDayOffset ? ' (+1 day)' : ''}
                      </td>
                      <td className={`${td} num text-right`}>
                        {s.unpaidBreakMinutes} / {s.paidBreakMinutes} <span className="text-xs text-ink-subtle">({s.breakBasis})</span>
                      </td>
                      <td className={`${td} num text-right`}>{minutes(s.paidMinutes)}</td>
                      <td className={`${td} text-xs`}>
                        r{s.revision}
                        {s.status === 'voided' ? ' voided' : ''}
                        {exports.map((e) => (
                          <div key={`${e.reference}-${e.rowType}`}>
                            {label(e.rowType)} in {e.reference}
                          </div>
                        ))}
                      </td>
                      <td className={td}>
                        {s.status === 'active' ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-accent">Correct or void</summary>
                            <form action={correctSegmentAction} className="mt-2 grid grid-cols-2 gap-1">
                              <input type="hidden" name="segmentId" value={s.id} />
                              <input type="hidden" name="batchId" value={b.id} />
                              <input type="hidden" name="rawName" value={s.rawName} />
                              <label className="sr-only" htmlFor={`cw-${s.id}`}>
                                Worker
                              </label>
                              <select id={`cw-${s.id}`} name="workerId" defaultValue={s.workerId ?? ''} className={`${small} col-span-2`}>
                                <option value="">Not identified</option>
                                {workers.map((w) => (
                                  <option key={w.id} value={w.id}>
                                    {w.name}
                                  </option>
                                ))}
                              </select>
                              <label className="sr-only" htmlFor={`cs-${s.id}`}>
                                Start
                              </label>
                              <input id={`cs-${s.id}`} name="startLocal" type="time" required defaultValue={s.startLocal.slice(0, 5)} className={small} />
                              <label className="sr-only" htmlFor={`ce-${s.id}`}>
                                Finish
                              </label>
                              <input id={`ce-${s.id}`} name="endLocal" type="time" required defaultValue={s.endLocal.slice(0, 5)} className={small} />
                              <label className="col-span-2 flex items-center gap-1 text-xs">
                                <input type="checkbox" name="endNextDay" value="1" defaultChecked={s.endDayOffset === 1} /> Finished next day
                              </label>
                              <label className="sr-only" htmlFor={`cu-${s.id}`}>
                                Unpaid break minutes
                              </label>
                              <input id={`cu-${s.id}`} name="unpaidBreakMinutes" type="number" min={0} placeholder="Unpaid (blank = rule)…" className={small} />
                              <label className="sr-only" htmlFor={`cp-${s.id}`}>
                                Paid break minutes
                              </label>
                              <input id={`cp-${s.id}`} name="paidBreakMinutes" type="number" min={0} placeholder="Paid break…" className={small} />
                              <label className="sr-only" htmlFor={`cr-${s.id}`}>
                                Reason
                              </label>
                              <input
                                id={`cr-${s.id}`}
                                name="reason"
                                required
                                minLength={5}
                                placeholder="Why, and on whose word…"
                                className={`${small} col-span-2`}
                              />
                              <button className="col-span-2 h-7 rounded border border-hairline-strong text-xs hover:bg-surface-2">Save Correction</button>
                            </form>
                            <form action={voidSegmentAction} className="mt-2 flex gap-1">
                              <input type="hidden" name="segmentId" value={s.id} />
                              <input type="hidden" name="batchId" value={b.id} />
                              <label className="sr-only" htmlFor={`vr-${s.id}`}>
                                Reason to void
                              </label>
                              <input id={`vr-${s.id}`} name="reason" required minLength={5} placeholder="Why it should not count…" className={small} />
                              <button className="h-7 rounded border border-hairline-strong px-2 text-xs text-bad hover:bg-bad-bg">Void</button>
                            </form>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {history.length ? (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-ink-subtle">Earlier revisions ({history.length})</summary>
                <ul className="mt-2 flex flex-col gap-1">
                  {history.map(({ s }) => (
                    <li key={s.id}>
                      {s.rawName} r{s.revision}: {s.startLocal.slice(0, 5)}–{s.endLocal.slice(0, 5)}, {minutes(s.paidMinutes)} paid ({s.reason}); replaced{' '}
                      {fmtDateTime(s.supersededAt)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          <Panel title="Decision">
            {b.state === 'approved' ? (
              <p className="text-sm text-ok">
                Approved. A correction reopens it for approval; anything already exported is corrected in the next export, not rewritten.
              </p>
            ) : mayApprove ? (
              <div className="flex flex-col gap-4">
                <form action={approveTimesheetAction} className="flex flex-col gap-2">
                  <input type="hidden" name="batchId" value={b.id} />
                  <input type="hidden" name="version" value={b.version} />
                  {review.length ? (
                    <Field label="Why approve despite the items to review" htmlFor="justification">
                      <textarea
                        id="justification"
                        name="justification"
                        required
                        minLength={10}
                        rows={3}
                        className="rounded-[var(--radius-ui)] border border-hairline-strong bg-surface p-2 text-sm"
                      />
                    </Field>
                  ) : null}
                  <Button variant="primary" type="submit" disabled={blocking.length > 0} className="self-start">
                    Approve Hours
                  </Button>
                  {blocking.length ? <p className="text-xs text-bad">Fix the blocking items first.</p> : null}
                </form>
                <form action={disputeTimesheetAction} className="flex flex-col gap-2">
                  <input type="hidden" name="batchId" value={b.id} />
                  <input type="hidden" name="version" value={b.version} />
                  <Field label="Dispute (what is wrong, who you are asking)" htmlFor="note">
                    <input id="note" name="note" required minLength={5} className={inputClass} />
                  </Field>
                  <Button variant="danger" type="submit" className="self-start">
                    Mark Disputed
                  </Button>
                </form>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">
                {b.recordedBy === me ? 'You entered this timesheet, so someone else must approve it.' : 'Approval needs a branch manager or payroll operator.'}
              </p>
            )}
          </Panel>
          <Panel title="Timesheet as received">
            <p className="mb-1 text-xs text-ink-subtle">Received {fmtDateTime(t.source.receivedAt)}</p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-xs">{t.source.rawText}</pre>
          </Panel>
          <Panel title="Approval history">
            {t.approvals.length ? (
              <ul className="flex flex-col gap-2 text-sm">
                {t.approvals.map((a) => (
                  <li key={a.id}>
                    <StateBadge state={a.decision} /> {fmtDateTime(a.decidedAt)}, {(a.segments as unknown[]).length} entries
                    {a.note ? <div className="text-xs text-ink-muted">{a.note}</div> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Not decided yet.</Empty>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
