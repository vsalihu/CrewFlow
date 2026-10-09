import { and, asc, eq, inArray } from 'drizzle-orm';
import { DomainError, externalBookingUpdateSchema, type ExternalBookingUpdateInput } from '@cds/contracts';
import { actorId, requireCapability } from '@cds/auth';
import { assignments, externalBookings, orderLines, orders, sites, workers, externalWorkerIds } from '@cds/db';
import { audit, checkVersion, command, notFound, nowOf, read, type ServiceContext } from './context';
import { closeTasksByKey } from './tasks';

// JoinedUp remains the system of record for its bookings. This is the manual entry and
// verification queue: "entered" means a person says they typed it in; "verified" means
// someone checked JoinedUp and recorded the booking ID and evidence for the current version.

export async function listExternalBookingQueue(ctx: ServiceContext, branchId: string) {
  requireCapability(ctx.actor, 'external_booking.verify', branchId);
  return read(ctx, async (tx) => {
    const rows = await tx
      .select({
        booking: externalBookings,
        workerName: workers.displayName,
        workerId: workers.id,
        reference: orders.reference,
        lineNo: orderLines.lineNo,
        serviceDate: orderLines.serviceDate,
        currentLineVersion: orderLines.lineVersion,
        siteName: sites.canonicalName,
        startAt: orderLines.startAt,
        assignmentState: assignments.state,
      })
      .from(externalBookings)
      .innerJoin(assignments, eq(assignments.id, externalBookings.assignmentId))
      .innerJoin(workers, eq(workers.id, assignments.workerId))
      .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .leftJoin(sites, eq(sites.id, orderLines.siteId))
      .where(
        and(
          eq(externalBookings.branchId, branchId),
          inArray(externalBookings.state, ['pending_entry', 'entered_unverified', 'verified', 'discrepancy', 'failed']),
        ),
      )
      .orderBy(asc(orderLines.serviceDate), asc(orders.reference));
    const ids = rows.map((r) => r.workerId);
    const ext = ids.length
      ? await tx
          .select()
          .from(externalWorkerIds)
          .where(and(inArray(externalWorkerIds.workerId, ids), eq(externalWorkerIds.provider, 'joinedup')))
      : [];
    return rows.map((r) => ({
      ...r,
      joinedUpWorkerId: ext.find((e) => e.workerId === r.workerId)?.externalId ?? null,
      /** Verified against an older shift version: needs updating in JoinedUp. */
      outOfDate: r.booking.lineVersion !== r.currentLineVersion,
    }));
  });
}

export async function updateExternalBooking(ctx: ServiceContext, id: string, raw: ExternalBookingUpdateInput): Promise<{ state: string; version: number }> {
  const input = externalBookingUpdateSchema.parse(raw);
  return command(ctx, { operation: 'external_booking.update', input: { id, ...input } }, async (tx) => {
    const [b] = await tx.select().from(externalBookings).where(eq(externalBookings.id, id)).for('update');
    if (!b) throw notFound('JoinedUp booking');
    requireCapability(ctx.actor, 'external_booking.verify', b.branchId);
    checkVersion(b.version, input.expectedVersion);
    const [a] = await tx.select({ lineId: assignments.lineId, state: assignments.state }).from(assignments).where(eq(assignments.id, b.assignmentId));
    const [line] = await tx.select({ v: orderLines.lineVersion }).from(orderLines).where(eq(orderLines.id, a!.lineId));
    const extId = input.externalBookingId?.trim() || null;
    const evidence = input.evidenceNote?.trim() || null;
    const set: Partial<typeof externalBookings.$inferInsert> = { version: b.version + 1, updatedAt: nowOf(ctx), updatedBy: actorId(ctx.actor) };
    switch (input.action) {
      case 'entered':
        if (!extId) throw new DomainError('VALIDATION_FAILED', 'Record the JoinedUp booking ID.', { fieldErrors: { externalBookingId: ['Required.'] } });
        Object.assign(set, {
          state: 'entered_unverified',
          externalBookingId: extId,
          enteredBy: actorId(ctx.actor),
          enteredAt: nowOf(ctx),
          lineVersion: line!.v,
        });
        break;
      case 'verified':
        if (!extId || !evidence) throw new DomainError('VALIDATION_FAILED', 'Verification needs the JoinedUp booking ID and what you checked.');
        if (a!.state !== 'accepted' && a!.state !== 'arrived')
          throw new DomainError('INVALID_STATE', `The assignment is ${a!.state}; do not verify a booking for it.`);
        Object.assign(set, {
          state: 'verified',
          externalBookingId: extId,
          verifiedBy: actorId(ctx.actor),
          verifiedAt: nowOf(ctx),
          evidenceNote: evidence,
          lineVersion: line!.v,
        });
        break;
      case 'failed':
      case 'discrepancy':
        if (!evidence) throw new DomainError('VALIDATION_FAILED', 'Describe what is wrong.');
        Object.assign(set, { state: input.action, evidenceNote: evidence });
        break;
      case 'cancellation_verified':
        if (!evidence) throw new DomainError('VALIDATION_FAILED', 'Record how the JoinedUp cancellation was checked.');
        Object.assign(set, { state: 'cancelled_verified', evidenceNote: evidence, verifiedBy: actorId(ctx.actor), verifiedAt: nowOf(ctx) });
        await closeTasksByKey(tx, ctx, `ju_cancel:${b.id}`, `JoinedUp cancellation verified: ${evidence}`);
        break;
    }
    await tx.update(externalBookings).set(set).where(eq(externalBookings.id, b.id));
    await audit(tx, ctx, {
      action: `external_booking.${input.action}`,
      entityType: 'external_booking',
      entityId: b.id,
      before: { state: b.state },
      after: { state: set.state, externalBookingId: extId },
      reason: evidence,
    });
    return { state: set.state as string, version: b.version + 1 };
  });
}
