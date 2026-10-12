import Link from 'next/link';
import { attendanceDay, operationalDates, referenceData } from '@cds/domain';
import { StateBadge } from '@/components/Status';
import { Badge, Button, Empty, Flash, LinkButton, Panel, td, th } from '@/components/ui';
import { fmtDate, fmtTime } from '@/lib/format';
import { requireContext } from '@/lib/session';
import { arrivalAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function AttendancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const ref = await referenceData(ctx);
  const branchId = sp.branch ?? ref.branches[0]?.id;
  if (!branchId) return <Empty>No branch access.</Empty>;
  const date = sp.date ?? operationalDates(new Date()).today;
  const day = await attendanceDay(ctx, { branchId, date });
  const back = `/attendance?${new URLSearchParams({ branch: branchId, date }).toString()}`;
  const arrived = day.booked.filter((b) => b.state === 'arrived').length;
  const noShow = day.booked.filter((b) => b.state === 'no_show').length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Attendance</h1>
        <form action="/attendance" className="flex items-center gap-2">
          <input type="hidden" name="branch" value={branchId} />
          <label htmlFor="date" className="sr-only">
            Date
          </label>
          <input
            key={date}
            id="date"
            name="date"
            type="date"
            defaultValue={date}
            className="h-8 rounded-[var(--radius-ui)] border border-hairline-strong bg-surface px-2 text-sm"
          />
          <Button type="submit">Show</Button>
        </form>
        <span className="text-sm text-ink-muted">{fmtDate(date)}</span>
        <div className="ml-auto flex gap-2">
          <LinkButton href="/attendance/rules">Break Rules</LinkButton>
          <LinkButton href={`/attendance/timesheets/new?${new URLSearchParams({ branch: branchId, date }).toString()}`} variant="primary">
            Record Timesheet
          </LinkButton>
        </div>
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      <p className="text-sm text-ink-muted">
        Bookings say who should be there. Arrivals record who turned up. Timesheets record the hours the client reports, and those hours are paid only after
        someone other than the person who entered them approves them.
      </p>

      <Panel title={`Booked (${day.booked.length}): ${arrived} arrived, ${noShow} no-show`}>
        {day.booked.length ? (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>Worker</th>
                  <th className={th}>Shift</th>
                  <th className={th}>Arrive / start</th>
                  <th className={th}>State</th>
                  <th className={th}>Record</th>
                </tr>
              </thead>
              <tbody>
                {day.booked.map((b) => (
                  <tr key={b.assignmentId}>
                    <td className={`${td} font-medium`}>{b.workerName}</td>
                    <td className={`${td} text-xs`}>
                      <Link href={`/orders/${b.orderId}`} className="font-mono text-accent hover:underline">
                        {b.reference}-{b.lineNo}
                      </Link>{' '}
                      {b.clientName} · {b.siteName ?? 'site not confirmed'}
                    </td>
                    <td className={`${td} num`}>
                      {fmtTime(b.arrivalAt)} / {fmtTime(b.startAt)}
                    </td>
                    <td className={td}>
                      <StateBadge state={b.state} />
                    </td>
                    <td className={td}>
                      <div className="flex gap-1">
                        {b.state !== 'arrived' ? (
                          <form action={arrivalAction}>
                            <input type="hidden" name="assignmentId" value={b.assignmentId} />
                            <input type="hidden" name="version" value={b.version} />
                            <input type="hidden" name="status" value="arrived" />
                            <input type="hidden" name="back" value={back} />
                            <button className="h-7 rounded border border-hairline-strong px-2 text-xs hover:bg-surface-2">Arrived</button>
                          </form>
                        ) : null}
                        {b.state !== 'no_show' ? (
                          <form action={arrivalAction}>
                            <input type="hidden" name="assignmentId" value={b.assignmentId} />
                            <input type="hidden" name="version" value={b.version} />
                            <input type="hidden" name="status" value="no_show" />
                            <input type="hidden" name="back" value={back} />
                            <button className="h-7 rounded border border-hairline-strong px-2 text-xs text-bad hover:bg-bad-bg">No Show</button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No confirmed bookings on this day.</Empty>
        )}
      </Panel>

      <Panel title={`Timesheets (${day.batches.length})`}>
        {day.batches.length ? (
          <ul className="flex flex-col divide-y divide-hairline text-sm">
            {day.batches.map(({ b, clientName, siteName, blocking, review }) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0">
                <Link href={`/attendance/timesheets/${b.id}`} className="font-mono text-accent hover:underline">
                  {b.reference}
                </Link>
                <span>
                  {clientName} · {siteName} · {b.supervisorName}
                </span>
                <StateBadge state={b.state} />
                {blocking ? <Badge tone="bad">{blocking} blocking</Badge> : null}
                {review ? <Badge tone="warn">{review} to review</Badge> : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No timesheets recorded for this day.</Empty>
        )}
      </Panel>
    </div>
  );
}
