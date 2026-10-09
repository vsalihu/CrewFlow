// Permission capabilities (build plan §4). Code checks capabilities, never role names.

export const CAPABILITIES = [
  'org.manage',
  'membership.manage',
  'integration.manage',
  'policy.manage',
  'branch.override',
  'client.read',
  'client.manage',
  'site.verify',
  'worker.read',
  'worker.manage',
  'worker.contact.read',
  'source.capture',
  'source.read',
  'order.read',
  'order.create',
  'order.amend',
  'order.accept',
  'order.cancel',
  'conflict.resolve',
  'assignment.propose',
  'assignment.record_response',
  'readiness.read',
  'readiness.approve',
  'trip.read',
  'trip.plan',
  'trip.record_acceptance',
  'trip.publish',
  'message.draft',
  'message.record_sent',
  'task.read',
  'task.manage',
  'duty.manage',
  'handover.manage',
  'external_booking.verify',
  'attendance.record',
  'attendance.approve',
  'payroll.export',
  'sensitive_document.read',
  'client.credit_release',
  'audit.read',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ROLES = [
  'org_admin',
  'branch_manager',
  'coordinator',
  'transport_dispatcher',
  'compliance_officer',
  'payroll_operator',
  'sales_onboarding',
] as const;
export type Role = (typeof ROLES)[number];

const COORDINATOR: Capability[] = [
  'client.read',
  'worker.read',
  'worker.contact.read',
  'source.capture',
  'source.read',
  'order.read',
  'order.create',
  'order.amend',
  'order.accept',
  'order.cancel',
  'conflict.resolve',
  'assignment.propose',
  'assignment.record_response',
  'readiness.read',
  'trip.read',
  'trip.plan',
  'trip.record_acceptance',
  'trip.publish',
  'message.draft',
  'message.record_sent',
  'task.read',
  'task.manage',
  'handover.manage',
  'external_booking.verify',
  'attendance.record',
];

/**
 * Default role → capability grants. Organisations may change these through
 * policy settings; this table is the documented starting point (docs/permissions.md).
 * Note what is absent: coordinators cannot approve readiness (compliance) or export payroll.
 */
export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  org_admin: ['org.manage', 'membership.manage', 'integration.manage', 'policy.manage', 'audit.read', 'client.read', 'order.read', 'task.read', 'trip.read', 'worker.read'],
  branch_manager: [...COORDINATOR, 'branch.override', 'client.manage', 'site.verify', 'worker.manage', 'duty.manage', 'audit.read', 'attendance.approve'],
  coordinator: COORDINATOR,
  transport_dispatcher: [
    'client.read',
    'worker.read',
    'worker.contact.read',
    'order.read',
    'readiness.read',
    'trip.read',
    'trip.plan',
    'trip.record_acceptance',
    'trip.publish',
    'message.draft',
    'message.record_sent',
    'task.read',
    'task.manage',
    'handover.manage',
  ],
  compliance_officer: ['worker.read', 'readiness.read', 'readiness.approve', 'sensitive_document.read', 'task.read', 'task.manage'],
  payroll_operator: ['worker.read', 'order.read', 'attendance.record', 'attendance.approve', 'payroll.export', 'task.read', 'task.manage'],
  sales_onboarding: ['client.read', 'client.manage', 'order.read', 'task.read', 'task.manage'],
};

export function capabilitiesForRoles(roles: readonly Role[]): Set<Capability> {
  const out = new Set<Capability>();
  for (const r of roles) for (const c of ROLE_CAPABILITIES[r]) out.add(c);
  return out;
}
