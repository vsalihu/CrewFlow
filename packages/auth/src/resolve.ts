import { sql } from 'drizzle-orm';
import { withContext, type Db } from '@cds/db';
import { DomainError } from '@cds/contracts';
import { buildStaffActor, type MembershipRow, type StaffActor } from './actor';

/**
 * Resolve the acting staff member for a verified auth user id. The organisation id is
 * never taken from the browser: if the user belongs to several organisations, the caller
 * passes the one selected server-side (e.g. from a signed session), and it must match a membership.
 */
export async function resolveStaffActor(db: Db, authUserId: string, organisationId?: string): Promise<StaffActor> {
  const result = await db.execute(sql`select * from app.resolve_memberships(${authUserId}::uuid)`);
  const rows = result.rows as unknown as MembershipRow[];
  const orgIds = [...new Set(rows.map((r) => r.organisation_id))];
  const orgId = organisationId ?? (orgIds.length === 1 ? orgIds[0] : undefined);
  if (!orgId || !orgIds.includes(orgId)) {
    throw new DomainError('PERMISSION_DENIED', 'No active membership for this organisation.');
  }
  const branchRows = await withContext(db, { organisationId: orgId, branchIds: [] }, (tx) => tx.execute(sql`select id from app.branches`));
  const allBranchIds = (branchRows.rows as { id: string }[]).map((r) => r.id);
  const actor = buildStaffActor(rows, orgId, allBranchIds);
  if (!actor) throw new DomainError('PERMISSION_DENIED', 'No active membership for this organisation.');
  return actor;
}
