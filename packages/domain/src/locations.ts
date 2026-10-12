import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { DomainError } from '@cds/contracts';
import { orderConflicts, workLocations, type Tx } from '@cds/db';

type LocationRow = typeof workLocations.$inferSelect;

/**
 * Whether an entrance/field may be given to workers and drivers for a site on a date:
 * it must belong to that site, be verified, and be valid on the date. One rule, used by
 * line readiness, message drafting and journey validation.
 */
export function locationProblem(loc: LocationRow | null | undefined, siteId: string | null, date: string): string | null {
  if (!loc) return 'No entrance or field is confirmed.';
  if (siteId && loc.siteId !== siteId) return `${loc.name} belongs to a different site.`;
  if (!loc.verifiedAt) return `${loc.name} has not been verified.`;
  if (loc.validFrom && loc.validFrom > date) return `${loc.name} is not valid until ${loc.validFrom}.`;
  if (loc.validTo && loc.validTo < date) return `${loc.name} stopped being valid on ${loc.validTo}.`;
  return null;
}

export function locationUsable(loc: LocationRow | null | undefined, siteId: string | null, date: string): boolean {
  return locationProblem(loc, siteId, date) === null;
}

/** Reject an entrance that belongs to another site (e.g. a field of a different client site). */
export async function assertLocationsMatchSites(tx: Tx, pairs: { siteId: string | null; workLocationId: string | null }[]): Promise<void> {
  const ids = [...new Set(pairs.map((p) => p.workLocationId).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const locs = await tx.select({ id: workLocations.id, siteId: workLocations.siteId }).from(workLocations).where(inArray(workLocations.id, ids));
  for (const p of pairs) {
    if (!p.workLocationId) continue;
    const loc = locs.find((l) => l.id === p.workLocationId);
    if (!loc || !p.siteId || loc.siteId !== p.siteId) {
      throw new DomainError('VALIDATION_FAILED', 'The entrance or field must belong to the selected site.', {
        fieldErrors: { workLocationId: ['Choose an entrance of this site.'] },
      });
    }
  }
}

/** Open source conflicts affecting any of these lines (line-specific or whole-order). */
export async function openConflictsFor(
  tx: Tx,
  lines: { orderId: string; lineId: string }[],
): Promise<{ lineId: string | null; orderId: string; field: string }[]> {
  if (!lines.length) return [];
  const orderIds = [...new Set(lines.map((l) => l.orderId))];
  const lineIds = lines.map((l) => l.lineId);
  return tx
    .select({ lineId: orderConflicts.lineId, orderId: orderConflicts.orderId, field: orderConflicts.fieldPath })
    .from(orderConflicts)
    .where(
      and(
        eq(orderConflicts.state, 'open'),
        inArray(orderConflicts.orderId, orderIds),
        or(isNull(orderConflicts.lineId), inArray(orderConflicts.lineId, lineIds)),
      ),
    );
}
