import Link from 'next/link';
import { operationalDates, referenceData, timesheetWorkerOptions } from '@cds/domain';
import { TimesheetRows } from '@/components/TimesheetRows';
import { Button, Empty, Field, Flash, Panel, inputClass, textareaClass } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { requireContext } from '@/lib/session';
import { recordTimesheetAction } from '../../../actions';

export const dynamic = 'force-dynamic';

function nowLocalInput(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

export default async function NewTimesheetPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const ref = await referenceData(ctx);
  const branchId = sp.branch ?? ref.branches[0]?.id;
  if (!branchId) return <Empty>No branch access.</Empty>;
  const date = sp.date ?? operationalDates(new Date()).today;
  const workers = await timesheetWorkerOptions(ctx, { branchId, date });
  const clientName = new Map(ref.clients.map((c) => [c.id, c.displayName]));
  return (
    <form action={recordTimesheetAction} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/attendance?${new URLSearchParams({ branch: branchId, date }).toString()}`} className="text-sm text-accent hover:underline">
          ← Attendance
        </Link>
        <h1 className="text-lg font-semibold">Record a timesheet for {fmtDate(date)}</h1>
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="serviceDate" value={date} />
      <div className="grid gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        <Panel title="Timesheet as received">
          <div className="flex flex-col gap-3">
            <Field label="Client site" htmlFor="clientSite">
              <select id="clientSite" name="clientSite" required className={inputClass}>
                <option value="">Choose the site</option>
                {ref.sites
                  .filter((s) => s.branchId === branchId)
                  .map((s) => (
                    <option key={s.id} value={`${s.clientId}|${s.id}`}>
                      {clientName.get(s.clientId)}: {s.canonicalName}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Supplied by (supervisor)" htmlFor="supervisorName">
                <input id="supervisorName" name="supervisorName" required autoComplete="off" className={inputClass} />
              </Field>
              <Field label="Received at (UK time)" htmlFor="receivedAt">
                <input id="receivedAt" name="receivedAt" type="datetime-local" required defaultValue={nowLocalInput()} className={inputClass} />
              </Field>
            </div>
            <Field label="Timesheet exactly as received" htmlFor="rawText" hint="Kept unchanged as evidence. A timesheet never creates or changes an order.">
              <textarea
                id="rawText"
                name="rawText"
                required
                rows={12}
                className={`${textareaClass} font-mono`}
                placeholder="Paste the message, or transcribe the photo line by line…"
              />
            </Field>
          </div>
        </Panel>
        <Panel title="People and hours">
          <TimesheetRows workers={workers} />
        </Panel>
      </div>
      <Button variant="primary" type="submit" className="self-start">
        Save Timesheet
      </Button>
    </form>
  );
}
