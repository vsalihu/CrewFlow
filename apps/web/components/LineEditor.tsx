'use client';

import { useState } from 'react';
import { inputClass } from './ui';

type Site = { id: string; name: string; clientId: string };
type Loc = { id: string; name: string; siteId: string; verified: boolean };
type Line = {
  serviceDate: string;
  siteId: string;
  workLocationId: string;
  role: string;
  requiredSkill: string;
  teamLabel: string;
  requestedCount: string;
  minimumCount: string;
  arrivalLocal: string;
  startLocal: string;
  endLocal: string;
  endDayOffset: '0' | '1';
  notes: string;
};

const blank = (date: string): Line => ({
  serviceDate: date,
  siteId: '',
  workLocationId: '',
  role: '',
  requiredSkill: '',
  teamLabel: '',
  requestedCount: '',
  minimumCount: '',
  arrivalLocal: '',
  startLocal: '',
  endLocal: '',
  endDayOffset: '0',
  notes: '',
});

/**
 * Repeatable shift lines. One request often holds several sites, roles and start times;
 * each becomes an independently staffed line. Empty fields stay empty: nothing is defaulted.
 */
export function LineEditor({
  clients,
  sites,
  locations,
  defaultDate,
}: {
  clients: { id: string; name: string }[];
  sites: Site[];
  locations: Loc[];
  defaultDate: string;
}) {
  const [lines, setLines] = useState<Line[]>([blank(defaultDate)]);
  const [clientId, setClientId] = useState('');
  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const payload = lines.map((l) => ({
    serviceDate: l.serviceDate,
    siteId: l.siteId || null,
    workLocationId: l.workLocationId || null,
    role: l.role || null,
    requiredSkill: l.requiredSkill || null,
    teamLabel: l.teamLabel || null,
    requestedCount: Number(l.requestedCount || 0),
    minimumCount: l.minimumCount ? Number(l.minimumCount) : null,
    arrivalLocal: l.arrivalLocal || null,
    startLocal: l.startLocal || null,
    endLocal: l.endLocal || null,
    endDayOffset: Number(l.endDayOffset) as 0 | 1,
    notes: l.notes || null,
  }));

  return (
    <div className="flex flex-col gap-3">
      <input type="hidden" name="lines" value={JSON.stringify(payload)} />
      <L id="clientId" label="Client">
        <select
          id="clientId"
          name="clientId"
          required
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
            setLines((ls) => ls.map((l) => ({ ...l, siteId: '', workLocationId: '' })));
          }}
          className={inputClass}
        >
          <option value="">Choose a client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </L>
      {lines.map((l, i) => {
        const siteOptions = sites.filter((s) => !clientId || s.clientId === clientId);
        const locOptions = locations.filter((x) => x.siteId === l.siteId);
        const p = `line-${i}`;
        return (
          <fieldset key={i} className="flex flex-col gap-3 rounded-[var(--radius-ui)] border border-hairline p-3">
            <legend className="px-1 text-xs font-medium text-ink-muted">Line {i + 1}</legend>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <L id={`${p}-date`} label="Work date">
                <input
                  id={`${p}-date`}
                  type="date"
                  required
                  value={l.serviceDate}
                  onChange={(e) => update(i, { serviceDate: e.target.value })}
                  className={inputClass}
                />
              </L>
              <L id={`${p}-site`} label="Site">
                <select id={`${p}-site`} value={l.siteId} onChange={(e) => update(i, { siteId: e.target.value, workLocationId: '' })} className={inputClass}>
                  <option value="">Not confirmed yet</option>
                  {siteOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </L>
              <L id={`${p}-loc`} label="Entrance / field">
                <select
                  id={`${p}-loc`}
                  value={l.workLocationId}
                  onChange={(e) => update(i, { workLocationId: e.target.value })}
                  className={inputClass}
                  disabled={!l.siteId}
                >
                  <option value="">Not confirmed yet</option>
                  {locOptions.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {x.verified ? '' : ' (unverified)'}
                    </option>
                  ))}
                </select>
              </L>
              <L id={`${p}-role`} label="Role">
                <input
                  id={`${p}-role`}
                  value={l.role}
                  onChange={(e) => update(i, { role: e.target.value })}
                  placeholder="e.g. Grader…"
                  autoComplete="off"
                  className={inputClass}
                />
              </L>
              <L id={`${p}-req`} label="Requested">
                <input
                  id={`${p}-req`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  required
                  value={l.requestedCount}
                  onChange={(e) => update(i, { requestedCount: e.target.value })}
                  className={inputClass}
                />
              </L>
              <L id={`${p}-min`} label="Minimum acceptable">
                <input
                  id={`${p}-min`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={l.minimumCount}
                  onChange={(e) => update(i, { minimumCount: e.target.value })}
                  className={inputClass}
                />
              </L>
              <L id={`${p}-skill`} label="Required skill">
                <input
                  id={`${p}-skill`}
                  value={l.requiredSkill}
                  onChange={(e) => update(i, { requiredSkill: e.target.value })}
                  placeholder="e.g. FLT…"
                  autoComplete="off"
                  className={inputClass}
                />
              </L>
              <L id={`${p}-team`} label="Team / supervisor">
                <input
                  id={`${p}-team`}
                  value={l.teamLabel}
                  onChange={(e) => update(i, { teamLabel: e.target.value })}
                  autoComplete="off"
                  className={inputClass}
                />
              </L>
              <L id={`${p}-arr`} label="Arrive by">
                <input
                  id={`${p}-arr`}
                  type="time"
                  value={l.arrivalLocal}
                  onChange={(e) => update(i, { arrivalLocal: e.target.value })}
                  className={inputClass}
                />
              </L>
              <L id={`${p}-start`} label="Paid start">
                <input id={`${p}-start`} type="time" value={l.startLocal} onChange={(e) => update(i, { startLocal: e.target.value })} className={inputClass} />
              </L>
              <L id={`${p}-end`} label="Expected end (blank if unknown)">
                <input id={`${p}-end`} type="time" value={l.endLocal} onChange={(e) => update(i, { endLocal: e.target.value })} className={inputClass} />
              </L>
              <L id={`${p}-next`} label="Ends">
                <select
                  id={`${p}-next`}
                  value={l.endDayOffset}
                  onChange={(e) => update(i, { endDayOffset: e.target.value as '0' | '1' })}
                  className={inputClass}
                >
                  <option value="0">Same day</option>
                  <option value="1">Next day (overnight)</option>
                </select>
              </L>
            </div>
            <L id={`${p}-notes`} label="Notes">
              <input id={`${p}-notes`} value={l.notes} onChange={(e) => update(i, { notes: e.target.value })} autoComplete="off" className={inputClass} />
            </L>
            {lines.length > 1 ? (
              <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} className="self-start text-xs text-bad hover:underline">
                Remove line {i + 1}
              </button>
            ) : null}
          </fieldset>
        );
      })}
      <button
        type="button"
        onClick={() => setLines((ls) => [...ls, { ...blank(ls.at(-1)?.serviceDate ?? defaultDate), siteId: ls.at(-1)?.siteId ?? '' }])}
        className="self-start rounded-[var(--radius-ui)] border border-hairline-strong px-3 py-1.5 text-sm hover:bg-surface-2"
      >
        Add Another Line
      </button>
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
