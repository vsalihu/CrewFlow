import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { DomainError, type TaskPriority } from '@cds/contracts';
import { actorId, requireCapability } from '@cds/auth';
import { dutyPeriods, tasks, type Tx } from '@cds/db';
import { audit, command, nowOf, notFound, type ServiceContext } from './context';

export type NewTask = {
  branchId: string | null;
  type: string;
  title: string;
  entityType?: string | null;
  entityId?: string | null;
  ownerMembershipId?: string | null;
  dueAt?: Date | null;
  priority?: TaskPriority;
  coverageAlert?: boolean;
  /** Prevents duplicate open tasks for the same purpose. */
  dedupeKey?: string | null;
};

/** Create a task unless an open task with the same dedupe key already exists. Returns the task id. */
export async function createTask(tx: Tx, ctx: ServiceContext, t: NewTask): Promise<string> {
  const values = {
    organisationId: ctx.actor.organisationId,
    branchId: t.branchId,
    type: t.type,
    title: t.title,
    entityType: t.entityType ?? null,
    entityId: t.entityId ?? null,
    ownerMembershipId: t.ownerMembershipId ?? null,
    dueAt: t.dueAt ?? null,
    priority: t.priority ?? 'normal',
    coverageAlert: t.coverageAlert ?? false,
    dedupeKey: t.dedupeKey ?? null,
    createdBy: actorId(ctx.actor),
  };
  if (t.dedupeKey) {
    const inserted = await tx
      .insert(tasks)
      .values(values)
      .onConflictDoNothing({
        target: [tasks.organisationId, tasks.dedupeKey],
        where: sql`state in ('open','in_progress') and dedupe_key is not null`,
      })
      .returning({ id: tasks.id });
    if (inserted[0]) return inserted[0].id;
    const [existing] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.dedupeKey, t.dedupeKey), inArray(tasks.state, ['open', 'in_progress'])));
    return existing!.id;
  }
  const [row] = await tx.insert(tasks).values(values).returning({ id: tasks.id });
  return row!.id;
}

/** Cancel open tasks by dedupe key (e.g. a call task that is no longer needed). */
export async function closeTasksByKey(tx: Tx, ctx: ServiceContext, dedupeKey: string, outcome: string, state: 'done' | 'cancelled' = 'done'): Promise<void> {
  await tx
    .update(tasks)
    .set({ state, outcome, completedAt: nowOf(ctx), completedBy: actorId(ctx.actor), updatedAt: nowOf(ctx), version: sql`${tasks.version} + 1` })
    .where(and(eq(tasks.dedupeKey, dedupeKey), inArray(tasks.state, ['open', 'in_progress'])));
}

/**
 * Complete a task. A recorded outcome is required: "sorted" with no detail is not evidence.
 */
export async function completeTask(
  ctx: ServiceContext,
  input: { taskId: string; outcome: string; expectedVersion?: number; idempotencyKey?: string },
): Promise<{ id: string; state: string }> {
  return command(ctx, { operation: 'task.complete', idempotencyKey: input.idempotencyKey, input }, async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update');
    if (!task) throw notFound('Task');
    requireCapability(ctx.actor, 'task.manage', task.branchId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== task.version) {
      throw new DomainError('VERSION_CONFLICT', 'This task changed. Reload and try again.', { currentVersion: task.version });
    }
    if (task.state === 'done' || task.state === 'cancelled') throw new DomainError('INVALID_STATE', 'This task is already closed.');
    const outcome = input.outcome.trim();
    if (outcome.length < 5) {
      throw new DomainError('VALIDATION_FAILED', 'Record what was done (for example who you spoke to and what they agreed).', {
        fieldErrors: { outcome: ['Describe the outcome.'] },
      });
    }
    await tx
      .update(tasks)
      .set({ state: 'done', outcome, completedAt: nowOf(ctx), completedBy: actorId(ctx.actor), updatedAt: nowOf(ctx), version: task.version + 1 })
      .where(eq(tasks.id, task.id));
    await audit(tx, ctx, { action: 'task.completed', entityType: 'task', entityId: task.id, after: { outcome } });
    return { id: task.id, state: 'done' };
  });
}

export async function assignTask(
  ctx: ServiceContext,
  input: { taskId: string; ownerMembershipId: string; expectedVersion?: number },
): Promise<void> {
  await command(ctx, { operation: 'task.assign' }, async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update');
    if (!task) throw notFound('Task');
    requireCapability(ctx.actor, 'task.manage', task.branchId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== task.version) {
      throw new DomainError('VERSION_CONFLICT', 'This task changed. Reload and try again.', { currentVersion: task.version });
    }
    await tx
      .update(tasks)
      .set({ ownerMembershipId: input.ownerMembershipId, coverageAlert: false, updatedAt: nowOf(ctx), version: task.version + 1 })
      .where(eq(tasks.id, task.id));
    await audit(tx, ctx, { action: 'task.assigned', entityType: 'task', entityId: task.id, before: { owner: task.ownerMembershipId }, after: { owner: input.ownerMembershipId } });
  });
}

/** The staff member on duty for a branch at an instant, with backup. Null if nobody is covering. */
export async function onDuty(tx: Tx, branchId: string, at: Date): Promise<{ membershipId: string; backupMembershipId: string | null } | null> {
  const [row] = await tx
    .select({ membershipId: dutyPeriods.membershipId, backupMembershipId: dutyPeriods.backupMembershipId })
    .from(dutyPeriods)
    .where(and(eq(dutyPeriods.branchId, branchId), lte(dutyPeriods.startsAt, at), gt(dutyPeriods.endsAt, at)))
    .orderBy(dutyPeriods.startsAt)
    .limit(1);
  return row ?? null;
}

export async function addDutyPeriod(
  ctx: ServiceContext,
  input: { branchId: string; membershipId: string; backupMembershipId?: string | null; startsAt: Date; endsAt: Date },
): Promise<string> {
  return command(ctx, { operation: 'duty.add' }, async (tx) => {
    requireCapability(ctx.actor, 'duty.manage', input.branchId);
    if (input.endsAt <= input.startsAt) throw new DomainError('VALIDATION_FAILED', 'Duty must end after it starts.');
    const [row] = await tx
      .insert(dutyPeriods)
      .values({
        organisationId: ctx.actor.organisationId,
        branchId: input.branchId,
        membershipId: input.membershipId,
        backupMembershipId: input.backupMembershipId ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        createdBy: actorId(ctx.actor),
      })
      .returning({ id: dutyPeriods.id });
    await audit(tx, ctx, { action: 'duty.added', entityType: 'duty_period', entityId: row!.id, after: input });
    return row!.id;
  });
}
