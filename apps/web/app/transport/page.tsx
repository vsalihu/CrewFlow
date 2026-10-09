import Link from 'next/link';
import { listTrips, operationalDates, referenceData, transportNeeds } from '@cds/domain';
import { StateBadge } from '@/components/Status';
import { Badge, Button, Empty, Field, Flash, LinkButton, Panel, inputClass, td, th } from '@/components/ui';
import { fmtDate, fmtTime, label } from '@/lib/format';
import { requireContext } from '@/lib/session';
import { returnPickupAction, transportRequirementAction } from '../actions';

export const dynamic = 'force-dynamic';

type Need = Awaited<ReturnType<typeof transportNeeds>>[number];

function legText(r: Need['outbound']): { text: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  if (!r) return { text: 'not set', tone: 'bad' };
  if (r.r.mode === 'agency_trip') return { text: `${r.tripRef} (${label(r.tripState ?? '')})`, tone: r.tripState === 'published' || r.tripState === 'departed' || r.tripState === 'completed' ? 'ok' : 'warn' };
  if (r.r.mode === 'private_confirmed') return { text: 'private, confirmed', tone: 'ok' };
  if (r.r.mode === 'not_required') return { text: 'not required', tone: 'neutral' };
  return r.r.accountableMembershipId ? { text: `unresolved, ${r.accountable} accountable`, tone: 'warn' } : { text: 'unresolved', tone: 'bad' };
}

export default async function TransportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const ref = await referenceData(ctx);
  const branchId = sp.branch ?? ref.branches[0]?.id;
  if (!branchId) return <Empty>No branch access.</Empty>;
  const { tomorrow } = operationalDates(new Date());
  const date = sp.date ?? tomorrow;
  const [trips, needs] = await Promise.all([listTrips(ctx, { branchId, date }), transportNeeds(ctx, { branchId, date })]);
  const back = `/transport?${new URLSearchParams({ branch: branchId, date }).toString()}`;
  const uncovered = needs.filter((n) => legText(n.outbound).tone === 'bad' || legText(n.return).tone === 'bad').length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Transport</h1>
        <form action="/transport" className="flex items-center gap-2">
          <input type="hidden" name="branch" value={branchId} />
          <label htmlFor="date" className="sr-only">
            Date
          </label>
          <input key={date} id="date" name="date" type="date" defaultValue={date} className="h-8 rounded-[var(--radius-ui)] border border-hairline-strong bg-surface px-2 text-sm" />
          <Button type="submit">Show</Button>
        </form>
        <span className="text-sm text-ink-muted">{fmtDate(date)}</span>
        <div className="ml-auto">
          <LinkButton href={`/transport/new?${new URLSearchParams({ branch: branchId, date }).toString()}`} variant="primary">
            Plan a Journey
          </LinkButton>
        </div>
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      <Panel title={`Journeys (${trips.length})`}>
        {trips.length ? (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Journey</th>
                  <th className={th}>Leg</th>
                  <th className={th}>Depart</th>
                  <th className={th}>Driver</th>
                  <th className={th}>Vehicle</th>
                  <th className={`${th} text-right`}>Passengers</th>
                  <th className={th}>State</th>
                </tr>
              </thead>
              <tbody>
                {trips.map((t) => (
                  <tr key={t.t.id} className="hover:bg-surface-2">
                    <td className={td}>
                      <Link href={`/trips/${t.t.id}`} className="font-mono text-accent hover:underline">
                        {t.t.reference}
                      </Link>{' '}
                      <span className="text-xs text-ink-subtle">r{t.t.currentRevision}</span>
                    </td>
                    <td className={td}>{label(t.t.legType)}</td>
                    <td className={`${td} num`}>{fmtTime(t.departure)}</td>
                    <td className={td}>{t.driverName ?? <Badge tone="bad">no driver</Badge>}</td>
                    <td className={td}>{t.vehicle ?? <Badge tone="bad">no vehicle</Badge>}</td>
                    <td className={`${td} num text-right`}>
                      {t.passengers} / {t.capacity ?? '?'}
                    </td>
                    <td className={td}>
                      <StateBadge state={t.t.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No journeys planned for this day.</Empty>
        )}
      </Panel>
      <Panel title={`Confirmed people and their journeys (${needs.length}${uncovered ? `, ${uncovered} with an uncovered leg` : ''})`}>
        {needs.length ? (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Worker</th>
                  <th className={th}>Shift</th>
                  <th className={th}>Outbound</th>
                  <th className={th}>Return</th>
                  <th className={th}>Record an arrangement</th>
                </tr>
              </thead>
              <tbody>
                {needs.map((n) => {
                  const out = legText(n.outbound);
                  const ret = legText(n.return);
                  return (
                    <tr key={n.assignmentId}>
                      <td className={td}>
                        <div className="font-medium">{n.workerName}</div>
                        {n.rawLabel ? <div className="text-xs text-ink-subtle">Roster label “{n.rawLabel}” (not interpreted)</div> : null}
                      </td>
                      <td className={`${td} text-xs`}>
                        <span className="font-mono">
                          {n.reference}-{n.lineNo}
                        </span>{' '}
                        {n.siteName} · arrive {fmtTime(n.arrivalAt)} · end {n.endAt ? fmtTime(n.endAt) : 'unknown'}
                      </td>
                      <td className={td}>
                        <Badge tone={out.tone}>{out.text}</Badge>
                      </td>
                      <td className={td}>
                        <Badge tone={ret.tone}>{ret.text}</Badge>
                      </td>
                      <td className={td}>
                        <form action={transportRequirementAction} className="flex flex-wrap items-center gap-1">
                          <input type="hidden" name="assignmentId" value={n.assignmentId} />
                          <input type="hidden" name="back" value={back} />
                          <label className="sr-only" htmlFor={`leg-${n.assignmentId}`}>
                            Leg
                          </label>
                          <select id={`leg-${n.assignmentId}`} name="leg" className="h-7 rounded border border-hairline-strong bg-surface px-1 text-xs">
                            <option value="outbound">Outbound</option>
                            <option value="return">Return</option>
                          </select>
                          <label className="sr-only" htmlFor={`mode-${n.assignmentId}`}>
                            Arrangement
                          </label>
                          <select id={`mode-${n.assignmentId}`} name="mode" className="h-7 rounded border border-hairline-strong bg-surface px-1 text-xs">
                            <option value="private_confirmed">Private (confirmed)</option>
                            <option value="unresolved">Unresolved, I am accountable</option>
                            <option value="not_required">Not required</option>
                          </select>
                          <label className="sr-only" htmlFor={`note-${n.assignmentId}`}>
                            Who confirmed and how
                          </label>
                          <input id={`note-${n.assignmentId}`} name="note" placeholder="Who confirmed, how…" className="h-7 w-40 rounded border border-hairline-strong bg-surface px-1 text-xs" />
                          <button className="h-7 rounded border border-hairline-strong px-2 text-xs hover:bg-surface-2">Save</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No confirmed workers on this day.</Empty>
        )}
      </Panel>
      {needs.length ? (
        <Panel title="Pickup request (finished early, unwell, other)">
          <form action={returnPickupAction} className="flex flex-col gap-3">
            <input type="hidden" name="back" value={back} />
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="mb-1 text-xs font-medium text-ink-muted">Who needs collecting</legend>
              {needs.map((n) => (
                <label key={n.assignmentId} className="flex items-center gap-1.5">
                  <input type="checkbox" name="assignmentId" value={n.assignmentId} /> {n.workerName}
                </label>
              ))}
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Pickup at (UK time)" htmlFor="pickupAt">
                <input id="pickupAt" name="pickupAt" type="datetime-local" required className={inputClass} />
              </Field>
              <Field label="Reason" htmlFor="reason">
                <select id="reason" name="reason" className={inputClass}>
                  <option value="finished">Work finished</option>
                  <option value="unwell">Unwell (welfare case)</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              <Field label="Restricted note (welfare cases only)" htmlFor="restrictedNote" hint="Not shown in task titles or messages.">
                <input id="restrictedNote" name="restrictedNote" autoComplete="off" className={inputClass} />
              </Field>
            </div>
            <Button variant="primary" type="submit" className="self-start">
              Request Pickup
            </Button>
          </form>
        </Panel>
      ) : null}
    </div>
  );
}
