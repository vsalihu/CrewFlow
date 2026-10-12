import { can } from '@cds/auth';
import { addDays } from '@cds/contracts';
import { listExports, operationalDates, referenceData } from '@cds/domain';
import { StateBadge } from '@/components/Status';
import { Badge, Button, Empty, Field, Flash, Panel, inputClass, td, th } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { requireContext } from '@/lib/session';
import { acknowledgeExportAction, createExportAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function ExportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const ref = await referenceData(ctx);
  const branches = ref.branches.filter((b) => can(ctx.actor, 'payroll.export', b.id));
  const branch = branches.find((b) => b.id === sp.branch) ?? branches[0];
  if (!branch) return <Empty>Payroll exports need the payroll export permission for a branch.</Empty>;
  const exports = await listExports(ctx, branch.id);
  const today = operationalDates(new Date()).today;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Payroll Exports</h1>
        {branches.length > 1 ? (
          <form action="/exports" className="flex items-center gap-2">
            <label htmlFor="branch" className="sr-only">
              Branch
            </label>
            <select
              id="branch"
              name="branch"
              defaultValue={branch.id}
              className="h-8 rounded-[var(--radius-ui)] border border-hairline-strong bg-surface px-2 text-sm"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <Button type="submit">Show</Button>
          </form>
        ) : (
          <span className="text-sm text-ink-muted">{branch.name}</span>
        )}
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      <p className="max-w-3xl text-sm text-ink-muted">
        An export contains approved hours not yet exported. Files are never regenerated or edited: if approved hours change after export, the next export
        reverses the old row and adds the corrected one. Nothing is sent anywhere automatically. Download the file, import it into payroll yourself, then record
        the payroll reference here.
      </p>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <Panel title={`Exports (${exports.length})`}>
          {exports.length ? (
            <div className="-m-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={th}>Reference</th>
                    <th className={th}>Work dates</th>
                    <th className={`${th} text-right`}>Rows</th>
                    <th className={th}>Created</th>
                    <th className={th}>SHA-256</th>
                    <th className={th}>Payroll import</th>
                  </tr>
                </thead>
                <tbody>
                  {exports.map((e) => (
                    <tr key={e.id}>
                      <td className={td}>
                        <a href={`/exports/${e.id}/download`} className="font-mono text-accent hover:underline">
                          {e.reference}.csv
                        </a>
                        {e.kind === 'correction' ? (
                          <div>
                            <Badge tone="warn">includes reversals</Badge>
                          </div>
                        ) : null}
                      </td>
                      <td className={`${td} text-xs`}>
                        {fmtDate(e.dateFrom)} to {fmtDate(e.dateTo)}
                      </td>
                      <td className={`${td} num text-right`}>{e.rowCount}</td>
                      <td className={`${td} text-xs`}>{fmtDateTime(e.createdAt)}</td>
                      <td className={`${td} font-mono text-xs`} title={e.checksum}>
                        {e.checksum.slice(0, 12)}…
                      </td>
                      <td className={td}>
                        {e.state === 'acknowledged' ? (
                          <div className="text-xs">
                            <StateBadge state={e.state} /> {e.acknowledgementReference}
                          </div>
                        ) : (
                          <form action={acknowledgeExportAction} className="flex gap-1">
                            <input type="hidden" name="exportId" value={e.id} />
                            <input type="hidden" name="branchId" value={branch.id} />
                            <label htmlFor={`ack-${e.id}`} className="sr-only">
                              Payroll reference for {e.reference}
                            </label>
                            <input
                              id={`ack-${e.id}`}
                              name="reference"
                              required
                              placeholder="Payroll batch or who confirmed…"
                              className="h-7 min-w-0 rounded border border-hairline-strong bg-surface px-1 text-xs"
                            />
                            <button className="h-7 rounded border border-hairline-strong px-2 text-xs hover:bg-surface-2">Record Import</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No exports yet for this branch.</Empty>
          )}
        </Panel>

        <Panel title="Create export">
          <form action={createExportAction} className="flex flex-col gap-3">
            <input type="hidden" name="branchId" value={branch.id} />
            <Field label="Work dates from" htmlFor="dateFrom">
              <input id="dateFrom" name="dateFrom" type="date" required defaultValue={addDays(today, -7)} className={inputClass} />
            </Field>
            <Field label="to" htmlFor="dateTo">
              <input id="dateTo" name="dateTo" type="date" required defaultValue={today} className={inputClass} />
            </Field>
            <p className="text-xs text-ink-subtle">Only approved timesheets are included. Disputed or unapproved timesheets wait for the next export.</p>
            <Button variant="primary" type="submit" className="self-start">
              Create Export
            </Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}
