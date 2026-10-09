import Link from 'next/link';
import { operationalDates, referenceData, transportNeeds } from '@cds/domain';
import { TripBuilder } from '@/components/TripBuilder';
import { Button, Empty, Flash, Panel } from '@/components/ui';
import { fmtDate, fmtTime } from '@/lib/format';
import { requireContext } from '@/lib/session';
import { createTripAction } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function NewTripPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const ref = await referenceData(ctx);
  const branchId = sp.branch ?? ref.branches[0]?.id;
  if (!branchId) return <Empty>No branch access.</Empty>;
  const date = sp.date ?? operationalDates(new Date()).tomorrow;
  const needs = await transportNeeds(ctx, { branchId, date });
  const siteName = new Map(ref.sites.map((s) => [s.id, s.canonicalName]));
  return (
    <form action={createTripAction} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/transport?${new URLSearchParams({ branch: branchId, date }).toString()}`} className="text-sm text-accent hover:underline">
          ← Transport
        </Link>
        <h1 className="text-lg font-semibold">Plan a journey for {fmtDate(date)}</h1>
      </div>
      <Flash error={sp.error} notice={sp.notice} />
      <Panel title="Route and manifest">
        <TripBuilder
          branchId={branchId}
          serviceDate={date}
          drivers={ref.drivers.filter((d) => d.branchId === branchId && d.willingToDrive).map((d) => ({ id: d.id, label: `${d.displayName}${d.readinessStatus === 'cleared' ? '' : ` (checks ${d.readinessStatus})`}` }))}
          vehicles={ref.vehicles.filter((v) => v.branchId === branchId).map((v) => ({ id: v.id, label: `${v.identifier} (${v.passengerCapacity ?? 'unknown'} passenger seats)` }))}
          locations={ref.locations.map((l) => ({ id: l.id, label: `${siteName.get(l.siteId) ?? ''}: ${l.name}${l.verifiedAt ? '' : ' (unverified)'}` }))}
          people={needs.map((n) => ({ assignmentId: n.assignmentId, workerId: n.workerId, name: n.workerName, detail: `${n.siteName ?? ''} arrive ${fmtTime(n.arrivalAt)}` }))}
        />
      </Panel>
      <Button variant="primary" type="submit" className="self-start">
        Save Draft Journey
      </Button>
    </form>
  );
}
