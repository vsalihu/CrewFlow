import Link from 'next/link';
import { can } from '@cds/auth';
import { listBreakPolicies, operationalDates, referenceData } from '@cds/domain';
import { Button, Empty, Field, Flash, Panel, inputClass, td, th } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { requireContext } from '@/lib/session';
import { addBreakPolicyAction } from '../../actions';

export const dynamic = 'force-dynamic';

const minutes = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

export default async function BreakRulesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const [policies, ref] = await Promise.all([listBreakPolicies(ctx), referenceData(ctx)]);
  const mayManage = can(ctx.actor, 'policy.manage');
  const today = operationalDates(new Date()).today;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/attendance" className="text-sm text-accent hover:underline">
          ← Attendance
        </Link>
        <h1 className="text-lg font-semibold">Break Rules</h1>
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      <p className="max-w-3xl text-sm text-ink-muted">
        A break rule applies only when a timesheet leaves the unpaid break blank. A site rule wins over the client rule. Rules are never edited: a new version
        applies from its start date and earlier timesheets keep the version that applied to them. A client with no rule must have the unpaid break entered from
        the timesheet.
      </p>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Panel title={`Rules (${policies.length})`}>
          {policies.length ? (
            <div className="-m-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={th}>Client / site</th>
                    <th className={th}>Version</th>
                    <th className={th}>Applies</th>
                    <th className={`${th} text-right`}>Unpaid break</th>
                    <th className={`${th} text-right`}>Paid break</th>
                    <th className={th}>Agreement</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map(({ p, clientName, siteName }) => (
                    <tr key={p.id}>
                      <td className={td}>
                        <span className="font-medium">{clientName}</span>
                        <div className="text-xs text-ink-subtle">{siteName ?? 'every site'}</div>
                      </td>
                      <td className={`${td} num`}>v{p.policyVersion}</td>
                      <td className={`${td} text-xs`}>
                        from {fmtDate(p.effectiveFrom)}
                        {p.effectiveTo ? ` to ${fmtDate(p.effectiveTo)}` : ''}
                      </td>
                      <td className={`${td} num text-right`}>
                        {p.unpaidBreakMinutes} min{p.unpaidBreakMinutes ? ` after ${minutes(p.unpaidAfterMinutes)}` : ''}
                      </td>
                      <td className={`${td} num text-right`}>{p.paidBreakMinutes} min</td>
                      <td className={`${td} font-mono text-xs`}>{p.agreementReference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No break rules agreed yet. Unpaid breaks must be entered from each timesheet.</Empty>
          )}
        </Panel>

        <Panel title="Add a rule version">
          {mayManage ? (
            <form action={addBreakPolicyAction} className="flex flex-col gap-3">
              <Field label="Client and site" htmlFor="scope">
                <select id="scope" name="scope" required className={inputClass}>
                  {ref.clients.map((c) => (
                    <optgroup key={c.id} label={c.displayName}>
                      <option value={`${c.id}|`}>{c.displayName}: every site</option>
                      {ref.sites
                        .filter((s) => s.clientId === c.id)
                        .map((s) => (
                          <option key={s.id} value={`${c.id}|${s.id}`}>
                            {c.displayName}: {s.canonicalName} only
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
              <Field label="Applies from" htmlFor="effectiveFrom">
                <input id="effectiveFrom" name="effectiveFrom" type="date" required defaultValue={today} className={inputClass} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Unpaid break (min)" htmlFor="unpaidBreakMinutes">
                  <input id="unpaidBreakMinutes" name="unpaidBreakMinutes" type="number" min={0} max={1440} required defaultValue={0} className={inputClass} />
                </Field>
                <Field label="Once worked (min)" htmlFor="unpaidAfterMinutes" hint="Deducted only if the shift is at least this long.">
                  <input id="unpaidAfterMinutes" name="unpaidAfterMinutes" type="number" min={0} max={1440} required defaultValue={0} className={inputClass} />
                </Field>
              </div>
              <Field label="Paid break (min)" htmlFor="paidBreakMinutes" hint="Recorded for reference; not deducted.">
                <input id="paidBreakMinutes" name="paidBreakMinutes" type="number" min={0} max={1440} required defaultValue={0} className={inputClass} />
              </Field>
              <Field label="Agreement reference" htmlFor="agreementReference" hint="The contract clause or email this rule comes from.">
                <input id="agreementReference" name="agreementReference" required className={inputClass} />
              </Field>
              <Field label="Note" htmlFor="note">
                <input id="note" name="note" className={inputClass} />
              </Field>
              <Button variant="primary" type="submit" className="self-start">
                Add Rule Version
              </Button>
            </form>
          ) : (
            <p className="text-sm text-ink-muted">Only an administrator can add break rules, because they change pay.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
