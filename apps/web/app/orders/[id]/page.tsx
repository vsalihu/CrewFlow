import Link from 'next/link';
import { getOrderDetail } from '@cds/domain';
import { StateBadge } from '@/components/Status';
import { TaskList } from '@/components/TaskList';
import { Badge, Button, Empty, Field, Flash, LinkButton, Panel, inputClass, td, th } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtTime, label } from '@/lib/format';
import { requireContext } from '@/lib/session';
import {
  acceptOrder,
  cancelOrderAction,
  draftMessageAction,
  raiseConflictAction,
  recordResponseAction,
  releaseAssignmentAction,
  replacementDeclinedAction,
  resolveConflictAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

const ACTIVE = ['proposed', 'offered', 'accepted', 'reconfirmation_required', 'arrived'];

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const { id } = await params;
  const sp = await searchParams;
  const d = await getOrderDetail(ctx, id);
  const o = d.order;
  const back = `/orders/${o.id}`;
  const closed = ['cancelled', 'closed', 'declined'].includes(o.requestState);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold">{o.reference}</h1>
        <StateBadge state={o.requestState} />
        {o.urgency !== 'normal' ? <StateBadge state={o.urgency} /> : null}
        <span className="text-sm text-ink-muted">{d.clientName}</span>
        <span className="text-xs text-ink-subtle">
          Owner: {d.ownerName ?? 'Unowned'} · Revision {o.currentRevision} · Received {fmtDateTime(o.receivedAt)}
        </span>
      </div>
      <Flash error={sp.error} notice={sp.notice} />

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          {d.lines.map(({ l, siteName, locationName, locationVerified, status }) => {
            const roster = d.assignments.filter((a) => a.a.lineId === l.id);
            const active = roster.filter((a) => ACTIVE.includes(a.a.state));
            const ended = roster.filter((a) => !ACTIVE.includes(a.a.state));
            return (
              <Panel
                key={l.id}
                title={`Line ${l.lineNo}: ${l.role ?? 'Role not set'}${l.teamLabel ? ` (${l.teamLabel})` : ''}`}
                actions={
                  l.lineState === 'open' && !closed ? (
                    <div className="flex gap-2">
                      <LinkButton href={`/orders/${o.id}/lines/${l.id}/amend`}>Amend</LinkButton>
                      <LinkButton href={`/orders/${o.id}/lines/${l.id}/assign`} variant="primary">
                        Assign Workers
                      </LinkButton>
                    </div>
                  ) : (
                    <StateBadge state={l.lineState} />
                  )
                }
              >
                <div className="flex flex-col gap-3">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                    <Def k="Date" v={fmtDate(l.serviceDate)} />
                    <Def k="Site" v={siteName ?? 'Not confirmed'} />
                    <Def k="Entrance" v={locationName ? `${locationName}${locationVerified ? '' : ' (unverified)'}` : 'Not confirmed'} />
                    <Def k="Arrive / start / end" v={`${fmtTime(l.arrivalAt)} / ${fmtTime(l.startAt)} / ${l.endUnknown ? 'unknown' : fmtTime(l.endAt)}${l.endDayOffset ? ' (+1 day)' : ''}`} />
                    <Def k="Requested" v={`${l.requestedCount}${l.minimumCount !== null ? ` (min ${l.minimumCount})` : ''}`} />
                    <Def k="Agency accepted" v={l.acceptedCount === null ? 'Not decided' : String(l.acceptedCount)} />
                    <Def k="Confirmed by workers" v={`${status.confirmed}${status.proposed ? `, ${status.proposed} awaiting reply` : ''}`} />
                    <Def k="Version" v={`v${l.lineVersion}`} />
                  </dl>
                  {status.blockers.length ? (
                    <ul aria-label="Blockers" className="flex flex-col gap-1 rounded-[var(--radius-ui)] bg-warn-bg p-3 text-sm text-warn">
                      {status.blockers.map((b, i) => (
                        <li key={i}>{b.message}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-[var(--radius-ui)] bg-ok-bg p-2 text-sm text-ok">Ready to dispatch: every requirement for this line is met.</p>
                  )}
                  {active.length ? (
                    <div className="-mx-4 overflow-x-auto">
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr>
                            <th className={th}>Worker</th>
                            <th className={th}>State</th>
                            <th className={th}>Transport</th>
                            <th className={th}>JoinedUp</th>
                            <th className={th}>Record reply</th>
                            <th className={th}>Message</th>
                          </tr>
                        </thead>
                        <tbody>
                          {active.map(({ a, workerName, transport, external, responses }) => (
                            <tr key={a.id}>
                              <td className={td}>
                                <div className="font-medium">{workerName}</div>
                                {a.rawTransportLabel ? <div className="text-xs text-ink-subtle">Roster label: “{a.rawTransportLabel}” (not interpreted)</div> : null}
                                {responses[0] ? <div className="text-xs text-ink-subtle">Last reply: {label(responses[0].response)} ({label(responses[0].outcome)})</div> : null}
                              </td>
                              <td className={td}>
                                <StateBadge state={a.state} />
                                {a.state === 'accepted' && a.acceptedLineVersion !== l.lineVersion ? <div className="text-xs text-bad">accepted v{a.acceptedLineVersion}</div> : null}
                              </td>
                              <td className={`${td} text-xs`}>
                                {(['outbound', 'return'] as const).map((leg) => {
                                  const r = transport.find((t) => t.r.leg === leg);
                                  return (
                                    <div key={leg}>
                                      {leg}: {r ? (r.r.mode === 'agency_trip' ? `${r.tripRef} (${label(r.tripState ?? '')})` : label(r.r.mode)) : 'not set'}
                                    </div>
                                  );
                                })}
                              </td>
                              <td className={td}>{external ? <StateBadge state={external.lineVersion !== l.lineVersion && external.state === 'verified' ? 'discrepancy' : external.state} /> : <span className="text-xs text-ink-subtle">n/a</span>}</td>
                              <td className={td}>
                                <form action={recordResponseAction} className="flex flex-wrap items-center gap-1">
                                  <input type="hidden" name="orderId" value={o.id} />
                                  <input type="hidden" name="assignmentId" value={a.id} />
                                  <input type="hidden" name="lineVersion" value={l.lineVersion} />
                                  <label className="sr-only" htmlFor={`resp-${a.id}`}>
                                    Reply
                                  </label>
                                  <select id={`resp-${a.id}`} name="response" className="h-7 rounded border border-hairline-strong bg-surface px-1 text-xs">
                                    <option value="accepted">Accepted v{l.lineVersion}</option>
                                    <option value="declined">Declined</option>
                                    <option value="no_answer">No answer</option>
                                    <option value="ambiguous">Unclear reply</option>
                                  </select>
                                  <label className="sr-only" htmlFor={`chan-${a.id}`}>
                                    Channel
                                  </label>
                                  <select id={`chan-${a.id}`} name="channel" className="h-7 rounded border border-hairline-strong bg-surface px-1 text-xs">
                                    <option value="phone">Phone</option>
                                    <option value="whatsapp_manual">WhatsApp</option>
                                    <option value="sms_manual">SMS</option>
                                    <option value="in_person">In person</option>
                                  </select>
                                  <button className="h-7 rounded border border-hairline-strong px-2 text-xs hover:bg-surface-2">Save</button>
                                </form>
                              </td>
                              <td className={td}>
                                <form action={draftMessageAction} className="flex items-center gap-1">
                                  <input type="hidden" name="assignmentId" value={a.id} />
                                  <input type="hidden" name="back" value={back} />
                                  <label className="sr-only" htmlFor={`tpl-${a.id}`}>
                                    Template
                                  </label>
                                  <select id={`tpl-${a.id}`} name="template" defaultValue={a.state === 'accepted' ? 'worker_booking' : a.state === 'reconfirmation_required' ? 'amendment' : 'worker_offer'} className="h-7 rounded border border-hairline-strong bg-surface px-1 text-xs">
                                    <option value="worker_offer">Offer</option>
                                    <option value="worker_booking">Booking</option>
                                    <option value="amendment">Amendment</option>
                                  </select>
                                  <button className="h-7 rounded border border-hairline-strong px-2 text-xs hover:bg-surface-2">Draft</button>
                                </form>
                                <details className="mt-1">
                                  <summary className="cursor-pointer text-xs text-ink-subtle">Release</summary>
                                  <form action={releaseAssignmentAction} className="mt-1 flex gap-1">
                                    <input type="hidden" name="orderId" value={o.id} />
                                    <input type="hidden" name="assignmentId" value={a.id} />
                                    <label className="sr-only" htmlFor={`rel-${a.id}`}>
                                      Reason
                                    </label>
                                    <input id={`rel-${a.id}`} name="reason" required placeholder="Reason…" className="h-7 min-w-0 rounded border border-hairline-strong bg-surface px-1 text-xs" />
                                    <button className="h-7 rounded border border-hairline-strong px-2 text-xs text-bad hover:bg-bad-bg">Release</button>
                                  </form>
                                </details>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty>No one assigned yet.</Empty>
                  )}
                  {ended.length ? (
                    <p className="text-xs text-ink-subtle">
                      Earlier: {ended.map((e) => `${e.workerName} (${label(e.a.state)})`).join(', ')}
                      {ended.filter((e) => e.a.state === 'cancelled').length ? (
                        <>
                          {' '}
                          {ended
                            .filter((e) => e.a.state === 'cancelled')
                            .map((e) => (
                              <form key={e.a.id} action={draftMessageAction} className="ml-1 inline">
                                <input type="hidden" name="assignmentId" value={e.a.id} />
                                <input type="hidden" name="back" value={back} />
                                <input type="hidden" name="template" value="cancellation" />
                                <button className="text-accent hover:underline">Draft cancellation to {e.workerName.split(' ')[0]}</button>
                              </form>
                            ))}
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  {l.lineState === 'open' && !l.replacementDeclinedAt ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-ink-subtle">Client says no replacement is needed</summary>
                      <form action={replacementDeclinedAction} className="mt-2 flex gap-2">
                        <input type="hidden" name="orderId" value={o.id} />
                        <input type="hidden" name="lineId" value={l.id} />
                        <label className="sr-only" htmlFor={`nr-${l.id}`}>
                          Note
                        </label>
                        <input id={`nr-${l.id}`} name="note" required placeholder="Who said so and when…" className={inputClass} />
                        <Button type="submit">Record</Button>
                      </form>
                    </details>
                  ) : l.replacementDeclinedAt ? (
                    <Badge>Client declined replacements {fmtDateTime(l.replacementDeclinedAt)}</Badge>
                  ) : null}
                </div>
              </Panel>
            );
          })}

          {!closed ? (
            <Panel title="Agency decision">
              <form action={acceptOrder} className="flex flex-col gap-3">
                <input type="hidden" name="orderId" value={o.id} />
                <input type="hidden" name="version" value={o.version} />
                <p className="text-sm text-ink-muted">How many can the agency actually supply for each line? Accepting fewer than requested records a shortfall; 0 declines the line.</p>
                <div className="flex flex-wrap gap-4">
                  {d.lines
                    .filter((x) => x.l.lineState === 'open')
                    .map(({ l }) => (
                      <div key={l.id} className="w-40">
                        <input type="hidden" name="lineId" value={l.id} />
                        <Field label={`Line ${l.lineNo} (requested ${l.requestedCount})`} htmlFor={`acc-${l.id}`}>
                          <input id={`acc-${l.id}`} name={`accepted_${l.id}`} type="number" inputMode="numeric" min={0} max={l.requestedCount} required defaultValue={l.acceptedCount ?? undefined} className={inputClass} />
                        </Field>
                      </div>
                    ))}
                </div>
                <Field label="Note to record (e.g. what the client was told)" htmlFor="acc-note">
                  <input id="acc-note" name="note" autoComplete="off" className={inputClass} />
                </Field>
                <Button variant="primary" type="submit" className="self-start">
                  Record Decision
                </Button>
              </form>
            </Panel>
          ) : null}

          <Panel title="Source conflicts">
            <div className="flex flex-col gap-3">
              {d.conflicts.length ? (
                d.conflicts.map((c) => (
                  <div key={c.id} className="rounded-[var(--radius-ui)] border border-hairline p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <StateBadge state={c.state === 'open' ? 'needs_clarification' : 'completed'} />
                      <span className="font-medium">{c.fieldPath}</span>
                    </div>
                    <ul className="mt-1 text-ink-muted">
                      {(c.observations as { value: string; note?: string | null }[]).map((ob, i) => (
                        <li key={i}>
                          “{ob.value}”{ob.note ? `: ${ob.note}` : ''}
                        </li>
                      ))}
                    </ul>
                    {c.state === 'open' ? (
                      <form action={resolveConflictAction} className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                        <input type="hidden" name="orderId" value={o.id} />
                        <input type="hidden" name="conflictId" value={c.id} />
                        <label className="sr-only" htmlFor={`rv-${c.id}`}>
                          Decided value
                        </label>
                        <input id={`rv-${c.id}`} name="resolvedValue" required placeholder="Decided value…" className={inputClass} />
                        <label className="sr-only" htmlFor={`rn-${c.id}`}>
                          How it was decided
                        </label>
                        <input id={`rn-${c.id}`} name="note" required placeholder="Who confirmed it and how…" className={inputClass} />
                        <Button type="submit">Resolve</Button>
                      </form>
                    ) : (
                      <p className="mt-1 text-xs text-ink-subtle">
                        Resolved as “{String(c.resolvedValue)}”: {c.resolutionNote}
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-sm text-ink-subtle">No conflicts recorded.</p>
              )}
              <details>
                <summary className="cursor-pointer text-sm text-accent">Record a conflict between sources</summary>
                <form action={raiseConflictAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                  <input type="hidden" name="orderId" value={o.id} />
                  <Field label="Line" htmlFor="cf-line">
                    <select id="cf-line" name="lineId" className={inputClass}>
                      <option value="">Whole order</option>
                      {d.lines.map(({ l }) => (
                        <option key={l.id} value={l.id}>
                          Line {l.lineNo}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="What disagrees" htmlFor="cf-field">
                    <input id="cf-field" name="fieldPath" required placeholder="e.g. start time…" className={inputClass} />
                  </Field>
                  <Field label="Value A" htmlFor="cf-a">
                    <input id="cf-a" name="valueA" required className={inputClass} />
                  </Field>
                  <Field label="Where A came from" htmlFor="cf-na">
                    <input id="cf-na" name="noteA" className={inputClass} />
                  </Field>
                  <Field label="Value B" htmlFor="cf-b">
                    <input id="cf-b" name="valueB" required className={inputClass} />
                  </Field>
                  <Field label="Where B came from" htmlFor="cf-nb">
                    <input id="cf-nb" name="noteB" className={inputClass} />
                  </Field>
                  <Button type="submit" className="self-end">
                    Record Conflict
                  </Button>
                </form>
              </details>
            </div>
          </Panel>

          {!closed ? (
            <Panel title="Cancel">
              <form action={cancelOrderAction} className="flex flex-col gap-3">
                <input type="hidden" name="orderId" value={o.id} />
                <input type="hidden" name="version" value={o.version} />
                <fieldset className="flex flex-wrap gap-4 text-sm">
                  <legend className="mb-1 text-xs font-medium text-ink-muted">Scope</legend>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name="scope" value="order" defaultChecked /> Whole order
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name="scope" value="lines" /> Selected lines
                  </label>
                  {d.lines.map(({ l }) => (
                    <label key={l.id} className="flex items-center gap-1.5">
                      <input type="checkbox" name="lineIds" value={l.id} /> Line {l.lineNo}
                    </label>
                  ))}
                </fieldset>
                <Field label="Reason (and who asked)" htmlFor="cx-reason">
                  <input id="cx-reason" name="reason" required className={inputClass} />
                </Field>
                <Button variant="danger" type="submit" className="self-start">
                  Cancel Selected Work
                </Button>
              </form>
            </Panel>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Open tasks">
            <TaskList tasks={d.tasks.map((t) => ({ ...t.t, ownerName: t.ownerName }))} back={back} />
          </Panel>
          <Panel title="Sources">
            <ul className="flex flex-col gap-3">
              {d.sources.map(({ s, relation, revisionNo }) => (
                <li key={`${s.id}-${revisionNo}`} className="text-sm">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-subtle">
                    <Badge tone="info">{label(s.kind)}</Badge>
                    <span>{label(relation)}</span>
                    <span>r{revisionNo}</span>
                    <span>{fmtDateTime(s.receivedAt)}</span>
                    <span>{s.kind === 'phone_note' ? `Call from ${s.callerName}, noted by staff` : (s.senderLabel ?? '')}</span>
                  </div>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-xs">{s.rawText}</pre>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Messages">
            {d.drafts.length ? (
              <ul className="flex flex-col gap-1.5 text-sm">
                {d.drafts.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2">
                    <Link href={`/messages/${m.id}?back=${encodeURIComponent(back)}`} className="truncate hover:underline">
                      {label(m.template)} v{m.entityRevision}
                    </Link>
                    <StateBadge state={m.state} />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No messages yet.</Empty>
            )}
          </Panel>
          <Panel title="Revision history">
            <ol className="flex flex-col gap-2 text-sm">
              {d.revisions.map((r) => (
                <li key={r.id}>
                  <div className="font-medium">
                    r{r.revisionNo}: {r.reason}
                  </div>
                  <div className="text-xs text-ink-subtle">{fmtDateTime(r.effectiveAt)}</div>
                  {(r.changes as { field?: string; from?: unknown; to?: unknown; lineNo?: number }[]).filter((c) => c.field).map((c, i) => (
                    <div key={i} className="text-xs text-ink-muted">
                      Line {c.lineNo} {c.field}: {String(c.from ?? 'none')} → {String(c.to ?? 'none')}
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Def({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-subtle">{k}</dt>
      <dd className="num break-words">{v}</dd>
    </div>
  );
}
