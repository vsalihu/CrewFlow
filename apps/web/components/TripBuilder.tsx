'use client';

import { useState } from 'react';
import { inputClass } from './ui';

type Opt = { id: string; label: string };
type Person = { assignmentId: string; workerId: string; name: string; detail: string };
type Stop = { purpose: 'pickup' | 'dropoff' | 'driver_own_work'; label: string; workLocationId: string; travelMinutesFromPrevious: string };

/**
 * Manual route and manifest editor. Only explicit driver records are offered as drivers;
 * vehicles show confirmed passenger seats or "unknown". Validation happens on the server.
 */
export function TripBuilder(props: {
  branchId: string;
  serviceDate: string;
  drivers: Opt[];
  vehicles: Opt[];
  locations: Opt[];
  people: Person[];
}) {
  const [legType, setLegType] = useState<'outbound' | 'return' | 'ad_hoc'>('outbound');
  const [driverId, setDriverId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [dep, setDep] = useState(`${props.serviceDate}T06:00`);
  const [end, setEnd] = useState(`${props.serviceDate}T07:00`);
  const [own, setOwn] = useState('');
  const [stops, setStops] = useState<Stop[]>([
    { purpose: 'pickup', label: '', workLocationId: '', travelMinutesFromPrevious: '' },
    { purpose: 'dropoff', label: '', workLocationId: '', travelMinutesFromPrevious: '' },
  ]);
  const [riders, setRiders] = useState<Record<string, { board: number; alight: number }>>({});
  const setStop = (i: number, p: Partial<Stop>) => setStops((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const payload = {
    branchId: props.branchId,
    serviceDate: props.serviceDate,
    legType,
    driverId: driverId || null,
    vehicleId: vehicleId || null,
    plannedDepartureAt: dep || null,
    estimatedEndAt: end || null,
    driverOwnAssignmentId: own || null,
    stops: stops.map((s) => ({
      purpose: s.purpose,
      label: s.label || props.locations.find((l) => l.id === s.workLocationId)?.label || 'Stop',
      workLocationId: s.workLocationId || null,
      travelMinutesFromPrevious: s.travelMinutesFromPrevious === '' ? null : Number(s.travelMinutesFromPrevious),
    })),
    passengers: Object.entries(riders).map(([assignmentId, r]) => {
      const p = props.people.find((x) => x.assignmentId === assignmentId)!;
      return { workerId: p.workerId, assignmentId, boardStopSeq: r.board, alightStopSeq: r.alight };
    }),
  };
  const stopOptions = stops.map((s, i) => (
    <option key={i} value={i + 1}>
      {i + 1}. {s.label || props.locations.find((l) => l.id === s.workLocationId)?.label || s.purpose}
    </option>
  ));

  return (
    <div className="flex flex-col gap-4">
      <input type="hidden" name="trip" value={JSON.stringify(payload)} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <L id="leg" label="Leg">
          <select id="leg" value={legType} onChange={(e) => setLegType(e.target.value as typeof legType)} className={inputClass}>
            <option value="outbound">Outbound</option>
            <option value="return">Return</option>
            <option value="ad_hoc">Ad hoc</option>
          </select>
        </L>
        <L id="driver" label="Driver (explicit records only)">
          <select id="driver" value={driverId} onChange={(e) => setDriverId(e.target.value)} className={inputClass}>
            <option value="">Not chosen</option>
            {props.drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </L>
        <L id="vehicle" label="Vehicle">
          <select id="vehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={inputClass}>
            <option value="">Not chosen</option>
            {props.vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </L>
        <L id="dep" label="Depart (UK time)">
          <input id="dep" type="datetime-local" value={dep} onChange={(e) => setDep(e.target.value)} className={inputClass} />
        </L>
        <L id="end" label="Driver free from">
          <input id="end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={inputClass} />
        </L>
        <L id="own" label="Driver's own shift (if any)">
          <select id="own" value={own} onChange={(e) => setOwn(e.target.value)} className={inputClass}>
            <option value="">None</option>
            {props.people.map((p) => (
              <option key={p.assignmentId} value={p.assignmentId}>
                {p.name}
              </option>
            ))}
          </select>
        </L>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Stops, in order</legend>
        {stops.map((s, i) => (
          <div key={i} className="grid grid-cols-2 items-end gap-2 md:grid-cols-[auto_1fr_1fr_120px_auto]">
            <span className="num pb-1.5 text-sm text-ink-subtle">{i + 1}.</span>
            <L id={`sp-${i}`} label="Purpose">
              <select id={`sp-${i}`} value={s.purpose} onChange={(e) => setStop(i, { purpose: e.target.value as Stop['purpose'] })} className={inputClass}>
                <option value="pickup">Pick up</option>
                <option value="dropoff">Drop off</option>
                <option value="driver_own_work">Driver&apos;s own shift</option>
              </select>
            </L>
            <L id={`sl-${i}`} label="Work location (verified entrances only reach drivers)">
              <select id={`sl-${i}`} value={s.workLocationId} onChange={(e) => setStop(i, { workLocationId: e.target.value })} className={inputClass}>
                <option value="">None (e.g. a pickup point)</option>
                {props.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </L>
            <L id={`st-${i}`} label="Minutes from previous">
              <input id={`st-${i}`} type="number" inputMode="numeric" min={0} disabled={i === 0} value={s.travelMinutesFromPrevious} onChange={(e) => setStop(i, { travelMinutesFromPrevious: e.target.value })} className={inputClass} />
            </L>
            <div className="flex items-center gap-2 md:col-span-1">
              <label htmlFor={`sn-${i}`} className="sr-only">
                Stop name
              </label>
              <input id={`sn-${i}`} placeholder="Name, e.g. Town square…" value={s.label} onChange={(e) => setStop(i, { label: e.target.value })} className={inputClass} />
              {stops.length > 2 ? (
                <button type="button" onClick={() => setStops((x) => x.filter((_, j) => j !== i))} className="text-xs text-bad hover:underline">
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        ))}
        <button type="button" onClick={() => setStops((x) => [...x, { purpose: 'dropoff', label: '', workLocationId: '', travelMinutesFromPrevious: '' }])} className="self-start rounded-[var(--radius-ui)] border border-hairline-strong px-3 py-1.5 text-sm hover:bg-surface-2">
          Add Stop
        </button>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Passengers ({Object.keys(riders).length})</legend>
        {props.people.length ? (
          props.people.map((p) => {
            const r = riders[p.assignmentId];
            return (
              <div key={p.assignmentId} className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex min-w-56 items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={!!r}
                    onChange={(e) =>
                      setRiders((x) => {
                        const n = { ...x };
                        if (e.target.checked) n[p.assignmentId] = { board: 1, alight: stops.length };
                        else delete n[p.assignmentId];
                        return n;
                      })
                    }
                  />
                  {p.name} <span className="text-xs text-ink-subtle">{p.detail}</span>
                </label>
                {r ? (
                  <>
                    <label className="text-xs text-ink-subtle" htmlFor={`b-${p.assignmentId}`}>
                      Board
                    </label>
                    <select id={`b-${p.assignmentId}`} value={r.board} onChange={(e) => setRiders((x) => ({ ...x, [p.assignmentId]: { ...r, board: Number(e.target.value) } }))} className="h-7 rounded border border-hairline-strong bg-surface px-1 text-xs">
                      {stopOptions}
                    </select>
                    <label className="text-xs text-ink-subtle" htmlFor={`a-${p.assignmentId}`}>
                      Get off
                    </label>
                    <select id={`a-${p.assignmentId}`} value={r.alight} onChange={(e) => setRiders((x) => ({ ...x, [p.assignmentId]: { ...r, alight: Number(e.target.value) } }))} className="h-7 rounded border border-hairline-strong bg-surface px-1 text-xs">
                      {stopOptions}
                    </select>
                  </>
                ) : null}
              </div>
            );
          })
        ) : (
          <p className="text-sm text-ink-subtle">No confirmed workers on this day.</p>
        )}
      </fieldset>
    </div>
  );
}

function L({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-ink-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
