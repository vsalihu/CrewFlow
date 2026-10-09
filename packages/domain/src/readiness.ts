import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DomainError, type ReadinessPolicy } from '@cds/contracts';
import { actorId, requireCapability } from '@cds/auth';
import { readinessChecks, readinessRequirements, workerSkills, type Tx } from '@cds/db';
import { audit, command, nowOf, type ServiceContext } from './context';

export type ReadinessIssue = {
  requirementId: string;
  label: string;
  scope: string;
  policy: ReadinessPolicy;
  status: string;
  subject: string;
};

export type ReadinessResult = { blocking: ReadinessIssue[]; warnings: ReadinessIssue[] };

function validOn(date: string, from: string | null, to: string | null): boolean {
  return (!from || from <= date) && (!to || to >= date);
}

/**
 * Evaluate configured readiness requirements for workers at a site/client on a date.
 * A requirement is satisfied only by a `cleared` check valid on that date, recorded by an
 * authorised officer. No legal conclusion is inferred from chat content; unknown stays unknown.
 */
export async function evaluateReadiness(
  tx: Tx,
  q: { workerIds: string[]; siteId: string | null; clientId: string; date: string },
): Promise<Map<string, ReadinessResult>> {
  const reqs = await tx
    .select()
    .from(readinessRequirements)
    .where(
      and(
        sql`${readinessRequirements.policy} <> 'not_required'`,
        or(isNull(readinessRequirements.clientId), eq(readinessRequirements.clientId, q.clientId)),
        q.siteId ? or(isNull(readinessRequirements.siteId), eq(readinessRequirements.siteId, q.siteId)) : isNull(readinessRequirements.siteId),
      ),
    );
  const applicable = reqs.filter((r) => validOn(q.date, r.effectiveFrom, r.effectiveTo));
  const out = new Map<string, ReadinessResult>();
  for (const w of q.workerIds) out.set(w, { blocking: [], warnings: [] });
  if (!applicable.length) return out;

  const checks = await tx
    .select()
    .from(readinessChecks)
    .where(
      inArray(
        readinessChecks.requirementId,
        applicable.map((r) => r.id),
      ),
    );

  const best = (pred: (c: (typeof checks)[number]) => boolean) => {
    const matching = checks.filter(pred);
    const cleared = matching.find((c) => c.status === 'cleared' && validOn(q.date, c.validFrom, c.validTo));
    if (cleared) return 'cleared';
    const latest = matching.sort((a, b) => (b.checkedAt?.getTime() ?? 0) - (a.checkedAt?.getTime() ?? 0))[0];
    if (!latest) return 'unknown';
    if (latest.status === 'cleared') return 'expired';
    return latest.status;
  };

  for (const r of applicable) {
    const policy = r.policy as ReadinessPolicy;
    const push = (workerId: string | null, status: string, subject: string) => {
      const issue: ReadinessIssue = { requirementId: r.id, label: r.label, scope: r.scope, policy, status, subject };
      const targets = workerId ? [workerId] : q.workerIds;
      for (const t of targets) {
        const res = out.get(t)!;
        (policy === 'blocking' ? res.blocking : res.warnings).push(issue);
      }
    };
    if (r.scope === 'site' || r.scope === 'client') {
      const status = best((c) => c.requirementId === r.id && (r.scope === 'site' ? c.siteId === q.siteId : c.clientId === q.clientId));
      if (status !== 'cleared') push(null, status, r.scope === 'site' ? 'site' : 'client');
      continue;
    }
    for (const w of q.workerIds) {
      const status = best((c) => c.requirementId === r.id && c.workerId === w && (r.scope === 'worker' || c.siteId === q.siteId));
      if (status !== 'cleared') push(w, status, 'worker');
    }
  }
  return out;
}

export async function workersWithSkill(tx: Tx, workerIds: string[], skill: string, date: string): Promise<Set<string>> {
  if (!workerIds.length) return new Set();
  const rows = await tx
    .select({ workerId: workerSkills.workerId, expiresOn: workerSkills.expiresOn })
    .from(workerSkills)
    .where(and(inArray(workerSkills.workerId, workerIds), sql`lower(${workerSkills.skill}) = lower(${skill})`));
  return new Set(rows.filter((r) => !r.expiresOn || r.expiresOn >= date).map((r) => r.workerId));
}

export function describeIssues(issues: ReadinessIssue[]): string {
  return issues.map((i) => `${i.label} (${i.status})`).join(', ');
}

/** Record an authorised readiness decision. Requires the readiness.approve capability. */
export async function recordReadinessCheck(
  ctx: ServiceContext,
  input: {
    requirementId: string;
    workerId?: string | null;
    siteId?: string | null;
    clientId?: string | null;
    status: 'pending' | 'cleared' | 'expired' | 'blocked' | 'unknown';
    validFrom?: string | null;
    validTo?: string | null;
    externalReference?: string | null;
    reason: string;
  },
): Promise<string> {
  requireCapability(ctx.actor, 'readiness.approve');
  if (!input.reason.trim()) throw new DomainError('VALIDATION_FAILED', 'Record the basis for this decision.');
  return command(ctx, { operation: 'readiness.check' }, async (tx) => {
    const [row] = await tx
      .insert(readinessChecks)
      .values({
        organisationId: ctx.actor.organisationId,
        requirementId: input.requirementId,
        workerId: input.workerId ?? null,
        siteId: input.siteId ?? null,
        clientId: input.clientId ?? null,
        status: input.status,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        externalReference: input.externalReference ?? null,
        reason: input.reason,
        checkedBy: actorId(ctx.actor),
        checkedAt: nowOf(ctx),
        createdBy: actorId(ctx.actor),
      })
      .returning({ id: readinessChecks.id });
    await audit(tx, ctx, { action: 'readiness.recorded', entityType: 'readiness_check', entityId: row!.id, after: { ...input } });
    return row!.id;
  });
}
