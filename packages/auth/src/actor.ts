import { DomainError, ROLES, capabilitiesForRoles, type Capability, type Role } from '@cds/contracts';

/** A signed-in staff member, resolved from verified identity + database memberships. */
export type StaffActor = {
  kind: 'staff';
  membershipId: string;
  organisationId: string;
  displayName: string;
  /** Capabilities granted organisation-wide (org roles). */
  orgCapabilities: ReadonlySet<Capability>;
  /** Capabilities per branch (branch roles plus org-wide grants). */
  branchCapabilities: ReadonlyMap<string, ReadonlySet<Capability>>;
};

/** Background jobs act as a recorded system actor scoped to one organisation. */
export type SystemActor = {
  kind: 'system';
  name: string;
  organisationId: string;
  branchIds: readonly string[];
};

export type Actor = StaffActor | SystemActor;

export function actorId(actor: Actor): string | null {
  return actor.kind === 'staff' ? actor.membershipId : null;
}

export function visibleBranchIds(actor: Actor): string[] {
  return actor.kind === 'staff' ? [...actor.branchCapabilities.keys()] : [...actor.branchIds];
}

export function can(actor: Actor, capability: Capability, branchId?: string | null): boolean {
  if (actor.kind === 'system') return true;
  if (actor.orgCapabilities.has(capability)) return true;
  if (branchId) return actor.branchCapabilities.get(branchId)?.has(capability) ?? false;
  for (const caps of actor.branchCapabilities.values()) if (caps.has(capability)) return true;
  return false;
}

export function requireCapability(actor: Actor, capability: Capability, branchId?: string | null): void {
  if (!can(actor, capability, branchId)) {
    throw new DomainError('PERMISSION_DENIED', 'You do not have permission to do this.');
  }
}

function toRoles(values: readonly string[]): Role[] {
  return values.filter((v): v is Role => (ROLES as readonly string[]).includes(v));
}

export type MembershipRow = {
  membership_id: string;
  organisation_id: string;
  display_name: string;
  org_roles: string[];
  branch_id: string | null;
  branch_roles: string[] | null;
};

/**
 * Build a staff actor from app.resolve_memberships rows for one organisation.
 * `allBranchIds` is used when an organisation-wide role (e.g. org_admin) should see every branch.
 */
export function buildStaffActor(rows: MembershipRow[], organisationId: string, allBranchIds: readonly string[]): StaffActor | null {
  const mine = rows.filter((r) => r.organisation_id === organisationId);
  const first = mine[0];
  if (!first) return null;
  const orgRoles = toRoles(first.org_roles);
  const orgCapabilities = capabilitiesForRoles(orgRoles);
  const branchCapabilities = new Map<string, Set<Capability>>();
  for (const r of mine) {
    if (!r.branch_id) continue;
    const caps = capabilitiesForRoles(toRoles(r.branch_roles ?? []));
    for (const c of orgCapabilities) caps.add(c);
    branchCapabilities.set(r.branch_id, caps);
  }
  if (orgRoles.includes('org_admin')) {
    for (const b of allBranchIds) if (!branchCapabilities.has(b)) branchCapabilities.set(b, new Set(orgCapabilities));
  }
  return {
    kind: 'staff',
    membershipId: first.membership_id,
    organisationId,
    displayName: first.display_name,
    orgCapabilities,
    branchCapabilities,
  };
}
