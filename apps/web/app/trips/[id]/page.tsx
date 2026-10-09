import Link from 'next/link';
import { getTripDetail } from '@cds/domain';
import { StateBadge } from '@/components/Status';
import { Badge, Button, Empty, Field, Flash, Panel, inputClass, td, th } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtTime, label } from '@/lib/format';
import { orNotFound, requireContext } from '@/lib/session';
import {
  addPassengerAction,
  cancelTripAction,
  disruptionAction,
  draftMessageAction,
  proposeTripAction,
  publishTripAction,
  tripAcceptanceAction,
  tripProgressAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

export default async function TripPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireContext();
  const { id } = await params;
  const sp = await searchParams;
  const d = await orNotFound(getTripDetail(ctx, id));
  const { trip, revision: rev } = d;
  const errors = d.violations.filter((v) => v.severity === 'error');
  const warnings = d.violations.filter((v) => v.severity === 'warning');
  const currentAcceptance = d.acceptances.find((a) => a.tripRevisionNo === rev.revisionNo);
  const back = `/trips/${trip.id}`;
  const capacity = d.vehicle?.passengerCapacity ?? null;
  const open = !['cancelled', 'completed'].includes(trip.state);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/transport" className="text-sm text-accent hover:underline">
          ← Transport
        </Link>
        <h1 className="font-mono text-lg font-semibold">{trip.reference}</h1>
        <StateBadge state={trip.state} />
        <span className="text-sm text-ink-muted">
          {label(trip.legType)} · {fmtDate(trip.serviceDate)} · revision {rev.revisionNo}
        </span>
      </div>
      <Flash error={sp.error} notice={sp.notice} />

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Route">
            <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-ink-subtle">Driver</dt>
                <dd>{d.driver?.displayName ?? 'Not named'}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-subtle">Vehicle</dt>
                <dd>{d.vehicle ? `${d.vehicle.identifier} (${capacity ?? 'unknown'} passenger seats)` : 'Not named'}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-subtle">Depart</dt>
                <dd className="num">{fmtDateTime(rev.plannedDepartureAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-subtle">Driver free from</dt>
                <dd className="num">{fmtDateTime(rev.estimatedEndAt)}</dd>
              </div>
            </dl>
            <div className="-mx-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={th}>#</th>
                    <th className={th}>ETA</th>
                    <th className={th}>Stop</th>
                    <th className={th}>Location</th>
                    <th className={th}>Collect / drop</th>
                    <th className={`${th} text-right`}>On board after</th>
                  </tr>
                </thead>
                <tbody>
                  {d.stops.map((s) => (
                    <tr key={s.id}>
                      <td className={`${td} num`}>{s.seq}</td>
                      <td className={`${td} num`}>{fmtTime(s.eta)}</td>
                      <td className={td}>
                        <div className="font-medium">{s.label}</div>
                        <div className="text-xs text-ink-subtle">{label(s.purpose)}</div>
                      </td>
                      <td className={`${td} text-xs`}>
                        {s.location ? (
                          <>
                            {s.location.name} {s.location.verifiedAt ? <Badge tone="ok">verified</Badge> : <Badge tone="bad">unverified</Badge>}
                          </>
                        ) : (
                          'None'
                        )}
                      </td>
                      <td className={`${td} text-xs`}>
                        {d.passengers
                          .filter(({ p }) => p.boardStopSeq === s.seq)
                          .map(({ name }) => `+ ${name}`)
                          .join(', ')}
                        {d.passengers.filter(({ p }) => p.alightStopSeq === s.seq).length ? (
                          <div className="text-ink-subtle">
                            {d.passengers
                              .filter(({ p }) => p.alightStopSeq === s.seq)
                              .map(({ name }) => `− ${name}`)
                              .join(', ')}
                          </div>
                        ) : null}
                      </td>
                      <td className={`${td} num text-right ${capacity !== null && s.onBoardAfter > capacity ? 'font-semibold text-bad' : ''}`}>
                        {s.seq < d.stops.length ? `${s.onBoardAfter} / ${capacity ?? '?'}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title={errors.length ? `Cannot publish yet (${errors.length})` : 'Checks'}>
            {errors.length || warnings.length ? (
              <ul className="flex flex-col gap-1.5 text-sm">
                {errors.map((v, i) => (
                  <li key={`e${i}`}>
                    <Badge tone="bad">{label(v.code.toLowerCase())}</Badge> {v.message}
                  </li>
                ))}
                {warnings.map((v, i) => (
                  <li key={`w${i}`}>
                    <Badge tone="warn">{label(v.code.toLowerCase())}</Badge> {v.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ok">Capacity, timing, private-party, location and conflict checks all pass.</p>
            )}
          </Panel>

          {open && trip.state !== 'departed' && d.available.length ? (
            <Panel title="Add a passenger">
              <form action={addPassengerAction} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="tripId" value={trip.id} />
                <Field label="Person" htmlFor="passenger">
                  <select id="passenger" name="passenger" className={inputClass}>
                    {d.available.map((a) => (
                      <option key={a.assignmentId} value={`${a.workerId}|${a.assignmentId}`}>
                        {a.name} ({a.reference})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Board at stop" htmlFor="board">
                  <input id="board" name="board" type="number" min={1} max={d.stops.length} defaultValue={1} className={`${inputClass} w-24`} />
                </Field>
                <Field label="Get off at stop" htmlFor="alight">
                  <input id="alight" name="alight" type="number" min={1} max={d.stops.length} defaultValue={d.stops.length} className={`${inputClass} w-24`} />
                </Field>
                <Button type="submit">Add (new revision)</Button>
              </form>
            </Panel>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Driver confirmation">
            <div className="flex flex-col gap-3 text-sm">
              <p>
                {currentAcceptance ? (
                  <>
                    Revision {rev.revisionNo}: <StateBadge state={currentAcceptance.decision} /> by {label(currentAcceptance.method)} at{' '}
                    {fmtDateTime(currentAcceptance.decidedAt)}
                  </>
                ) : (
                  <>The driver has not answered for revision {rev.revisionNo}.</>
                )}
              </p>
              {trip.state === 'draft' ? (
                <form action={proposeTripAction}>
                  <input type="hidden" name="tripId" value={trip.id} />
                  <input type="hidden" name="version" value={trip.version} />
                  <Button type="submit">Propose to Driver</Button>
                </form>
              ) : null}
              {['proposed', 'driver_accepted'].includes(trip.state) ? (
                <form action={tripAcceptanceAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="tripId" value={trip.id} />
                  <input type="hidden" name="revisionNo" value={rev.revisionNo} />
                  <Field label="Answer" htmlFor="decision">
                    <select id="decision" name="decision" className={inputClass}>
                      <option value="accepted">Accepted revision {rev.revisionNo}</option>
                      <option value="declined">Declined</option>
                    </select>
                  </Field>
                  <Field label="How" htmlFor="method">
                    <select id="method" name="method" className={inputClass}>
                      <option value="phone">Phone call</option>
                      <option value="whatsapp_manual">WhatsApp reply</option>
                      <option value="in_person">In person</option>
                    </select>
                  </Field>
                  <Button type="submit">Record</Button>
                </form>
              ) : null}
              {trip.state === 'driver_accepted' ? (
                <form action={publishTripAction}>
                  <input type="hidden" name="tripId" value={trip.id} />
                  <input type="hidden" name="version" value={trip.version} />
                  <Button variant="primary" type="submit" disabled={errors.length > 0}>
                    Publish Journey
                  </Button>
                </form>
              ) : null}
              {d.driver && ['driver_accepted', 'published', 'proposed'].includes(trip.state) ? (
                <form action={draftMessageAction}>
                  <input type="hidden" name="tripId" value={trip.id} />
                  <input type="hidden" name="template" value="driver_manifest" />
                  <input type="hidden" name="back" value={back} />
                  <Button type="submit">Draft Driver Manifest</Button>
                </form>
              ) : null}
              {trip.state === 'published' ? (
                <form action={tripProgressAction}>
                  <input type="hidden" name="tripId" value={trip.id} />
                  <input type="hidden" name="version" value={trip.version} />
                  <input type="hidden" name="state" value="departed" />
                  <Button type="submit">Mark Departed</Button>
                </form>
              ) : null}
              {['departed', 'disrupted'].includes(trip.state) ? (
                <form action={tripProgressAction}>
                  <input type="hidden" name="tripId" value={trip.id} />
                  <input type="hidden" name="version" value={trip.version} />
                  <input type="hidden" name="state" value="completed" />
                  <Button type="submit">Mark Completed</Button>
                </form>
              ) : null}
            </div>
          </Panel>
          {open ? (
            <Panel title="Problems">
              <div className="flex flex-col gap-3">
                <form action={disruptionAction} className="flex flex-col gap-2">
                  <input type="hidden" name="tripId" value={trip.id} />
                  <Field label="What happened" htmlFor="kind">
                    <select id="kind" name="kind" className={inputClass}>
                      <option value="breakdown">Breakdown</option>
                      <option value="driver_cancelled">Driver cancelled</option>
                      <option value="delay">Delay</option>
                      <option value="other">Other</option>
                    </select>
                  </Field>
                  <Field label="Details (restricted)" htmlFor="dnote">
                    <input id="dnote" name="note" required className={inputClass} />
                  </Field>
                  <Button variant="danger" type="submit" className="self-start">
                    Report Disruption
                  </Button>
                </form>
                {trip.state !== 'departed' ? (
                  <details>
                    <summary className="cursor-pointer text-sm text-ink-subtle">Cancel this journey</summary>
                    <form action={cancelTripAction} className="mt-2 flex flex-col gap-2">
                      <input type="hidden" name="tripId" value={trip.id} />
                      <input type="hidden" name="version" value={trip.version} />
                      <label htmlFor="creason" className="sr-only">
                        Reason
                      </label>
                      <input id="creason" name="reason" required placeholder="Reason…" className={inputClass} />
                      <Button variant="danger" type="submit" className="self-start">
                        Cancel Journey
                      </Button>
                    </form>
                  </details>
                ) : null}
              </div>
            </Panel>
          ) : null}
          <Panel title="Messages">
            {d.drafts.length ? (
              <ul className="flex flex-col gap-1.5 text-sm">
                {d.drafts.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2">
                    <Link href={`/messages/${m.id}?back=${encodeURIComponent(back)}`} className="hover:underline">
                      Manifest r{m.entityRevision}
                    </Link>
                    <StateBadge state={m.state} />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No manifests drafted.</Empty>
            )}
          </Panel>
          <Panel title="Revision history">
            <ol className="flex flex-col gap-1.5 text-sm">
              {d.revisions.map((r) => (
                <li key={r.id}>
                  r{r.revisionNo}: {r.reason} <span className="text-xs text-ink-subtle">{fmtDateTime(r.createdAt)}</span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </div>
  );
}
