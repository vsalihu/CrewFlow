import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { DomainError } from '@cds/contracts';
import { actorId, requireCapability } from '@cds/auth';
import { handoverSnapshots, memberships, tasks } from '@cds/db';
import { audit, command, notFound, nowOf, type ServiceContext } from './context';

/**
 * Hand over open work: a time-stamped snapshot plus reassignment of the outgoing person's open
 * tasks to the incoming owner, who must acknowledge receipt. Unacknowledged handovers stay visible.
 */
export async function createHandover(ctx: ServiceContext, input: { branchId: string; incomingMembershipId: string; note?: string | null }): Promise<{ id: string; taskCount: number }> {
  requireCapability(ctx.actor, 'handover.manage', input.branchId);
  const outgoing = actorId(ctx.actor);
  if (!outgoing) throw new DomainError('PERMISSION_DENIED', 'Only a staff member can hand over.');
  if (outgoing === input.incomingMembershipId) throw new DomainError('VALIDATION_FAILED', 'Choose someone else to hand over to.');
  return command(ctx, { operation: 'handover.create' }, async (tx) => {
    const [incoming] = await tx.select({ id: memberships.id, name: memberships.displayName }).from(memberships).where(eq(memberships.id, input.incomingMembershipId));
    if (!incoming) throw notFound('Staff member');
    const open = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.branchId, input.branchId),
          inArray(tasks.state, ['open', 'in_progress']),
          or(eq(tasks.ownerMembershipId, outgoing), isNull(tasks.ownerMembershipId)),
        ),
      );
    const ids = open.map((t) => t.id);
    if (ids.length) {
      await tx.update(tasks).set({ ownerMembershipId: incoming.id, coverageAlert: false, updatedAt: nowOf(ctx) }).where(inArray(tasks.id, ids));
    }
    const [row] = await tx
      .insert(handoverSnapshots)
      .values({
        organisationId: ctx.actor.organisationId,
        branchId: input.branchId,
        outgoingMembershipId: outgoing,
        incomingMembershipId: incoming.id,
        asOf: nowOf(ctx),
        taskIds: ids,
        summary: { tasks: open.map((t) => ({ id: t.id, title: t.title, priority: t.priority, dueAt: t.dueAt })) } as never,
        note: input.note ?? null,
      })
      .returning({ id: handoverSnapshots.id });
    await audit(tx, ctx, { action: 'handover.created', entityType: 'handover', entityId: row!.id, after: { incoming: incoming.id, tasks: ids.length } });
    return { id: row!.id, taskCount: ids.length };
  });
}

export async function acknowledgeHandover(ctx: ServiceContext, handoverId: string): Promise<void> {
  await command(ctx, { operation: 'handover.ack' }, async (tx) => {
    const [h] = await tx.select().from(handoverSnapshots).where(eq(handoverSnapshots.id, handoverId)).for('update');
    if (!h) throw notFound('Handover');
    if (h.incomingMembershipId !== actorId(ctx.actor)) throw new DomainError('PERMISSION_DENIED', 'Only the incoming person can acknowledge this handover.');
    if (h.acknowledgedAt) return;
    await tx.update(handoverSnapshots).set({ acknowledgedAt: nowOf(ctx) }).where(eq(handoverSnapshots.id, h.id));
    await audit(tx, ctx, { action: 'handover.acknowledged', entityType: 'handover', entityId: h.id });
  });
}
