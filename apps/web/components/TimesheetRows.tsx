'use client';

import { useState } from 'react';
import { inputClass } from './ui';

type Worker = { id: string; name: string; booked: boolean };
type Row = { workerId: string; rawName: string; startLocal: string; endLocal: string; nextDay: boolean; unpaid: string; paid: string; note: string };

const blank = (): Row => ({ workerId: '', rawName: '', startLocal: '', endLocal: '', nextDay: false, unpaid: '', paid: '', note: '' });

/**
 * One row per person as written on the timesheet. The name is kept exactly as written; matching it
 * to a worker is a separate choice, and an unmatched name blocks approval until someone identifies it.
 */
export function TimesheetRows({ workers }: { workers: Worker[] }) {
  const [rows, setRows] = useState<Row[]>([blank()]);
  const update = (i: number, p: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const entries = rows.map((r) => ({
    workerId: r.workerId || null,
    rawName: r.rawName,
    startLocal: r.startLocal,
    endLocal: r.endLocal,
    endDayOffset: r.nextDay ? 1 : 0,
    unpaidBreakMinutes: r.unpaid === '' ? null : Number(r.unpaid),
    paidBreakMinutes: r.paid === '' ? null : Number(r.paid),
    note: r.note || null,
  }));
  return (
    <div className="flex flex-col gap-3">
      <input type="hidden" name="entries" value={JSON.stringify(entries)} />
      {rows.map((r, i) => (
        <fieldset key={i} className="grid grid-cols-2 gap-2 rounded-[var(--radius-ui)] border border-hairline p-3 md:grid-cols-4 xl:grid-cols-8">
          <legend className="px-1 text-xs font-medium text-ink-muted">Row {i + 1}</legend>
          <L id={`n-${i}`} label="Name as written">
            <input
              id={`n-${i}`}
              required
              value={r.rawName}
              onChange={(e) => update(i, { rawName: e.target.value })}
              autoComplete="off"
              className={inputClass}
            />
          </L>
          <L id={`w-${i}`} label="Worker">
            <select
              id={`w-${i}`}
              value={r.workerId}
              onChange={(e) => update(i, { workerId: e.target.value, rawName: r.rawName || (workers.find((w) => w.id === e.target.value)?.name ?? '') })}
              className={inputClass}
            >
              <option value="">Not identified yet</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.booked ? ' (booked today)' : ''}
                </option>
              ))}
            </select>
          </L>
          <L id={`s-${i}`} label="Start">
            <input id={`s-${i}`} type="time" required value={r.startLocal} onChange={(e) => update(i, { startLocal: e.target.value })} className={inputClass} />
          </L>
          <L id={`e-${i}`} label="Finish">
            <input id={`e-${i}`} type="time" required value={r.endLocal} onChange={(e) => update(i, { endLocal: e.target.value })} className={inputClass} />
          </L>
          <label className="flex items-end gap-1.5 pb-1.5 text-xs">
            <input type="checkbox" checked={r.nextDay} onChange={(e) => update(i, { nextDay: e.target.checked })} /> Finished next day
          </label>
          <L id={`u-${i}`} label="Unpaid break (blank = rule)">
            <input
              id={`u-${i}`}
              type="number"
              inputMode="numeric"
              min={0}
              value={r.unpaid}
              onChange={(e) => update(i, { unpaid: e.target.value })}
              className={inputClass}
            />
          </L>
          <L id={`p-${i}`} label="Paid break">
            <input
              id={`p-${i}`}
              type="number"
              inputMode="numeric"
              min={0}
              value={r.paid}
              onChange={(e) => update(i, { paid: e.target.value })}
              className={inputClass}
            />
          </L>
          <div className="flex items-end gap-2">
            <L id={`o-${i}`} label="Note">
              <input id={`o-${i}`} value={r.note} onChange={(e) => update(i, { note: e.target.value })} autoComplete="off" className={inputClass} />
            </L>
            {rows.length > 1 ? (
              <button type="button" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} className="pb-1.5 text-xs text-bad hover:underline">
                Remove
              </button>
            ) : null}
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() => setRows((r) => [...r, blank()])}
        className="self-start rounded-[var(--radius-ui)] border border-hairline-strong px-3 py-1.5 text-sm hover:bg-surface-2"
      >
        Add Row
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
