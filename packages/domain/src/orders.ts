import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  ACTIVE_ASSIGNMENT_STATES,
  DomainError,
  acceptanceSchema,
  amendmentSchema,
  cancellationSchema,
  createOrderSchema,
  formatServiceDate,
  raiseConflictSchema,
  resolveConflictSchema,
  type AcceptanceInput,
  type Amendment,
  type AmendmentInput,
  type CancellationInput,
  type CreateOrderInput,
  type LineChange,
  type RaiseConflictInput,
  type ResolveConflictInput,
  type UrgencyLevel,
} from '@cds/contracts';
import { actorId, requireCapability } from '@cds/auth';
import {
  assignments,
  branches,
  clients,
  externalBookings,
  messageDrafts,
  orderConflicts,
  orderLines,
  orderRevisions,
  orderSourceLinks,
  orders,
  organisations,
  resourceReservations,
  sites,
  sourceMessages,
  tasks,
  transportRequirements,
  tripPassengers,
  tripRevisions,
  trips,
  workers,
  type Tx,
} from '@cds/db';
import { audit, checkVersion, command, enqueue, nextReference, notFound, nowOf, pgErrorCode, type ServiceContext } from './context';
import { LINE_FIELDS, MATERIAL_LINE_FIELDS, computeLineTimes, hhmm, lineFieldsFromInput, reservationInterval, tstzrange, type LineFields } from './lines';
import { policyFrom, type OperatingPolicy } from './policy';
import { closeTasksByKey, createTask, onDuty } from './tasks';
import { impactTokenSecret } from './config';

type OrderRow = typeof orders.$inferSelect;
type LineRow = typeof orderLines.$inferSelect;

export async function loadPolicy(tx: Tx, branchId: string): Promise<OperatingPolicy> {
  const [row] = await tx
    .select({ org: organisations.settings, branch: branches.settings })
    .from(branches)
    .innerJoin(organisations, eq(organisations.id, branches.organisationId))
    .where(eq(branches.id, branchId));
  return policyFrom(row?.org, row?.branch);
}

export function lineFieldsFromRow(l: LineRow): LineFields {
  return {
    serviceDate: l.serviceDate,
    siteId: l.siteId,
    workLocationId: l.workLocationId,
    role: l.role,
    requiredSkill: l.requiredSkill,
    teamLabel: l.teamLabel,
    requestedCount: l.requestedCount,
    minimumCount: l.minimumCount,
    arrivalLocal: hhmm(l.arrivalLocal),
    startLocal: hhmm(l.startLocal),
    startWindowEndLocal: hhmm(l.startWindowEndLocal),
    endLocal: hhmm(l.endLocal),
    endDayOffset: l.endDayOffset,
    timezone: l.timezone,
    breakRule: l.breakRule,
    notes: l.notes,
  };
}

/** Urgency from time until the earliest required arrival (build plan §5.4). */
export function computeUrgency(now: Date, earliestArrival: Date | null, policy: OperatingPolicy): UrgencyLevel {
  if (!earliestArrival) return 'normal';
  const hours = (earliestArrival.getTime() - now.getTime()) / 3_600_000;
  if (hours < policy.urgentOrderHours) return 'urgent';
  if (hours <= policy.lateOrderHours) return 'late';
  return 'normal';
}

async function assertSourcesExist(tx: Tx, ids: readonly string[], branchId: string): Promise<void> {
  if (!ids.length) return;
  const rows = await tx.select({ id: sourceMessages.id, branchId: sourceMessages.branchId }).from(sourceMessages).where(inArray(sourceMessages.id, [...ids]));
  if (rows.length !== new Set(ids).size) throw new DomainError('VALIDATION_FAILED', 'A linked source message was not found.');
  if (rows.some((r) => r.branchId !== branchId)) throw new DomainError('VALIDATION_FAILED', 'Source messages must belong to the same branch as the order.');
}

async function assertSitesBelongToClient(tx: Tx, clientId: string, siteIds: (string | null)[]): Promise<void> {
  const ids = [...new Set(siteIds.filter((s): s is string => !!s))];
  if (!ids.length) return;
  const rows = await tx.select({ id: sites.id, clientId: sites.clientId }).from(sites).where(inArray(sites.id, ids));
  if (rows.length !== ids.length || rows.some((r) => r.clientId !== clientId)) {
    throw new DomainError('VALIDATION_FAILED', 'Each site must belong to the ordering client.', { fieldErrors: { siteId: ['Unknown site for this client.'] } });
  }
}

async function snapshotOrder(tx: Tx, orderId: string): Promise<Record<string, unknown>> {
  const [o] = await tx.select().from(orders).where(eq(orders.id, orderId));
  const ls = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.lineNo));
  return {
    order: { reference: o!.reference, clientId: o!.clientId, clientContactId: o!.clientContactId, requestState: o!.requestState, ownerMembershipId: o!.ownerMembershipId },
    lines: ls.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      lineVersion: l.lineVersion,
      lineState: l.lineState,
      acceptedCount: l.acceptedCount,
      ...lineFieldsFromRow(l),
    })),
  };
}

async function writeRevision(
  tx: Tx,
  ctx: ServiceContext,
  order: { id: string; currentRevision: number },
  revisionNo: number,
  reason: string,
  changes: unknown[],
  sourceIds: readonly string[],
  relation: 'request' | 'amendment' | 'cancellation' | 'confirmation',
): Promise<void> {
  await tx.insert(orderRevisions).values({
    organisationId: ctx.actor.organisationId,
    orderId: order.id,
    revisionNo,
    snapshot: (await snapshotOrder(tx, order.id)) as never,
    changes: changes as never,
    reason,
    actorId: actorId(ctx.actor),
    sourceMessageIds: [...sourceIds],
    effectiveAt: nowOf(ctx),
  });
  for (const s of sourceIds) {
    await tx.insert(orderSourceLinks).values({
      organisationId: ctx.actor.organisationId,
      orderId: order.id,
      revisionNo,
      sourceMessageId: s,
      relation,
      createdBy: actorId(ctx.actor),
    });
  }
}

async function insertLine(tx: Tx, ctx: ServiceContext, order: { id: string; branchId: string }, lineNo: number, f: LineFields): Promise<LineRow> {
  const t = computeLineTimes(f);
  const [row] = await tx
    .insert(orderLines)
    .values({
      organisationId: ctx.actor.organisationId,
      branchId: order.branchId,
      orderId: order.id,
      lineNo,
      ...f,
      arrivalAt: t.arrivalAt,
      startAt: t.startAt,
      endAt: t.endAt,
      endUnknown: t.endUnknown,
      createdBy: actorId(ctx.actor),
    })
    .returning();
  return row!;
}

// ------------------------------------------------------------------ create

export async function createOrder(ctx: ServiceContext, raw: CreateOrderInput, idempotencyKey?: string): Promise<{ id: string; reference: string; urgency: UrgencyLevel }> {
  const input = createOrderSchema.parse(raw);
  requireCapability(ctx.actor, 'order.create', input.branchId);
  return command(ctx, { operation: 'order.create', idempotencyKey, input }, async (tx) => {
    const [client] = await tx.select().from(clients).where(eq(clients.id, input.clientId));
    if (!client) throw notFound('Client');
    await assertSourcesExist(tx, input.sourceMessageIds, input.branchId);
    await assertSitesBelongToClient(tx, input.clientId, input.lines.map((l) => l.siteId ?? null));
    const sources = await tx.select({ receivedAt: sourceMessages.receivedAt }).from(sourceMessages).where(inArray(sourceMessages.id, input.sourceMessageIds));
    const receivedAt = sources.map((s) => s.receivedAt).sort((a, b) => a.getTime() - b.getTime())[0] ?? nowOf(ctx);

    const reference = await nextReference(tx, ctx, 'order', 'ORD');
    const [order] = await tx
      .insert(orders)
      .values({
        organisationId: ctx.actor.organisationId,
        branchId: input.branchId,
        clientId: input.clientId,
        clientContactId: input.clientContactId ?? null,
        reference,
        ownerMembershipId: input.ownerMembershipId ?? actorId(ctx.actor),
        requestState: input.requestState ?? 'received',
        sourceAuthority: input.sourceAuthority ?? null,
        receivedAt,
        createdBy: actorId(ctx.actor),
      })
      .returning();

    const lines: LineRow[] = [];
    for (const [i, l] of input.lines.entries()) lines.push(await insertLine(tx, ctx, order!, i + 1, lineFieldsFromInput(l)));

    const policy = await loadPolicy(tx, input.branchId);
    const arrivals = lines.map((l) => l.arrivalAt ?? l.startAt).filter((d): d is Date => !!d);
    const earliest = arrivals.sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const urgency = computeUrgency(nowOf(ctx), earliest, policy);
    await tx.update(orders).set({ urgency }).where(eq(orders.id, order!.id));

    // Entry does not imply the agency can fulfil it: a late/urgent order creates a review task
    // for whoever is on duty, or an unowned coverage alert if nobody is covering.
    if (urgency !== 'normal') {
      const duty = await onDuty(tx, input.branchId, nowOf(ctx));
      await createTask(tx, ctx, {
        branchId: input.branchId,
        type: 'late_order_review',
        title: `${urgency === 'urgent' ? 'Urgent' : 'Late'} order ${reference} from ${client.displayName}: check feasible staff, transport and ETA`,
        entityType: 'order',
        entityId: order!.id,
        ownerMembershipId: duty?.membershipId ?? null,
        priority: urgency === 'urgent' ? 'urgent' : 'high',
        dueAt: new Date(nowOf(ctx).getTime() + policy.urgentAckMinutes * 60_000),
        coverageAlert: !duty && urgency === 'urgent',
        dedupeKey: `late_order:${order!.id}`,
      });
    }
    for (const l of lines) {
      if (!l.siteId) {
        await createTask(tx, ctx, {
          branchId: input.branchId,
          type: 'clarify_site',
          title: `Confirm the site for ${reference} line ${l.lineNo} (${formatServiceDate(l.serviceDate)})`,
          entityType: 'order_line',
          entityId: l.id,
          ownerMembershipId: order!.ownerMembershipId,
          dedupeKey: `clarify_site:${l.id}`,
        });
      }
    }

    await writeRevision(tx, ctx, { id: order!.id, currentRevision: 1 }, 1, 'Order created', [], input.sourceMessageIds, 'request');
    await audit(tx, ctx, { action: 'order.created', entityType: 'order', entityId: order!.id, after: { reference, lines: lines.length, urgency } });
    await enqueue(tx, ctx, { eventType: 'order.created', entityType: 'order', entityId: order!.id, entityRevision: 1 });
    return { id: order!.id, reference, urgency };
  });
}

// ------------------------------------------------------------------ amendment impact

export type LineFieldChange = { lineId: string; lineNo: number; field: string; from: unknown; to: unknown };

export type AmendmentImpact = {
  orderId: string;
  version: number;
  changes: LineFieldChange[];
  addedLines: number;
  materialLineIds: string[];
  reconfirmations: { assignmentId: string; workerId: string; workerName: string; lineId: string }[];
  staleOffers: { assignmentId: string; workerName: string; lineId: string }[];
  excessAssignments: { lineId: string; accepted: number; active: number }[];
  pendingMessagesToSupersede: number;
  sentMessagesNeedingAmendment: number;
  tripsAffected: { tripId: string; reference: string; state: string }[];
  externalBookingsToUpdate: number;
  token: string;
};

function inputHash(orderId: string, input: Omit<Amendment, 'acknowledgeImpactToken'>): string {
  const { expectedVersion, lineChanges, addLines, reason, sourceMessageIds } = input;
  return createHash('sha256').update(JSON.stringify({ orderId, expectedVersion, lineChanges, addLines, reason, sourceMessageIds })).digest('hex');
}

function signImpact(orderId: string, version: number, hash: string, expiresAt: number): string {
  const sig = createHmac('sha256', impactTokenSecret()).update(`${orderId}|${version}|${hash}|${expiresAt}`).digest('base64url');
  return `${expiresAt}.${sig}`;
}

function verifyImpactToken(token: string | undefined, orderId: string, version: number, hash: string, now: Date): void {
  if (!token) throw new DomainError('STALE_PREVIEW', 'Preview the impact of this change before saving it.');
  const [exp, sig] = token.split('.');
  const expiresAt = Number(exp);
  if (!sig || !Number.isFinite(expiresAt) || expiresAt < now.getTime()) {
    throw new DomainError('STALE_PREVIEW', 'The impact preview has expired. Preview again.');
  }
  const expected = Buffer.from(signImpact(orderId, version, hash, expiresAt));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new DomainError('STALE_PREVIEW', 'The order or the change differs from what was previewed. Preview again.');
  }
}

type PlannedLineChange = { line: LineRow; next: LineFields; changed: LineFieldChange[]; material: boolean };

function planLineChange(line: LineRow, change: LineChange): PlannedLineChange {
  const current = lineFieldsFromRow(line);
  const next: LineFields = { ...current };
  const changed: LineFieldChange[] = [];
  for (const field of LINE_FIELDS) {
    if (!(field in change)) continue;
    const raw = (change as Record<string, unknown>)[field];
    const value = raw === undefined ? (field === 'endDayOffset' ? 0 : field === 'timezone' ? 'Europe/London' : null) : raw;
    if ((current as Record<string, unknown>)[field] !== value) {
      changed.push({ lineId: line.id, lineNo: line.lineNo, field, from: (current as Record<string, unknown>)[field], to: value });
      (next as Record<string, unknown>)[field] = value;
    }
  }
  const material = changed.some((c) => (MATERIAL_LINE_FIELDS as readonly string[]).includes(c.field));
  return { line, next, changed, material };
}

async function computeImpact(tx: Tx, order: OrderRow, input: Amendment): Promise<Omit<AmendmentImpact, 'token'> & { plans: PlannedLineChange[] }> {
  const lineIds = input.lineChanges.map((c) => c.lineId);
  const lines = lineIds.length ? await tx.select().from(orderLines).where(and(eq(orderLines.orderId, order.id), inArray(orderLines.id, lineIds))) : [];
  if (lines.length !== new Set(lineIds).size) throw new DomainError('VALIDATION_FAILED', 'A changed line does not belong to this order.');
  const plans: PlannedLineChange[] = [];
  for (const c of input.lineChanges) {
    const line = lines.find((l) => l.id === c.lineId)!;
    if (line.lineState === 'cancelled') throw new DomainError('INVALID_STATE', `Line ${line.lineNo} is cancelled.`);
    const plan = planLineChange(line, c);
    computeLineTimes(plan.next); // validate before any write
    plans.push(plan);
  }
  for (const l of input.addLines) computeLineTimes(lineFieldsFromInput(l));

  const materialLineIds = plans.filter((p) => p.material).map((p) => p.line.id);
  const touchedLineIds = plans.map((p) => p.line.id);
  const active = touchedLineIds.length
    ? await tx
        .select({ id: assignments.id, lineId: assignments.lineId, workerId: assignments.workerId, state: assignments.state, workerName: workers.displayName })
        .from(assignments)
        .innerJoin(workers, eq(workers.id, assignments.workerId))
        .where(and(inArray(assignments.lineId, touchedLineIds), inArray(assignments.state, [...ACTIVE_ASSIGNMENT_STATES])))
    : [];
  const reconfirmations = active
    .filter((a) => materialLineIds.includes(a.lineId) && (a.state === 'accepted' || a.state === 'reconfirmation_required'))
    .map((a) => ({ assignmentId: a.id, workerId: a.workerId, workerName: a.workerName, lineId: a.lineId }));
  const staleOffers = active
    .filter((a) => materialLineIds.includes(a.lineId) && (a.state === 'proposed' || a.state === 'offered'))
    .map((a) => ({ assignmentId: a.id, workerName: a.workerName, lineId: a.lineId }));
  const excessAssignments: AmendmentImpact['excessAssignments'] = [];
  for (const p of plans) {
    const accepted = p.line.acceptedCount === null ? null : Math.min(p.line.acceptedCount, p.next.requestedCount);
    const activeCount = active.filter((a) => a.lineId === p.line.id && a.state !== 'arrived').length;
    if (accepted !== null && activeCount > accepted) excessAssignments.push({ lineId: p.line.id, accepted, active: activeCount });
  }

  const drafts = materialLineIds.length
    ? await tx.select({ state: messageDrafts.state }).from(messageDrafts).where(and(eq(messageDrafts.entityType, 'order_line'), inArray(messageDrafts.entityId, materialLineIds)))
    : [];
  const affectedAssignmentIds = [...reconfirmations.map((r) => r.assignmentId), ...staleOffers.map((s) => s.assignmentId)];
  const tripRows = affectedAssignmentIds.length
    ? await tx
        .selectDistinct({ tripId: trips.id, reference: trips.reference, state: trips.state })
        .from(tripPassengers)
        .innerJoin(tripRevisions, eq(tripRevisions.id, tripPassengers.tripRevisionId))
        .innerJoin(trips, and(eq(trips.id, tripRevisions.tripId), eq(trips.currentRevision, tripRevisions.revisionNo)))
        .where(and(inArray(tripPassengers.assignmentId, affectedAssignmentIds), sql`${trips.state} not in ('cancelled','completed')`))
    : [];
  const ext = reconfirmations.length
    ? await tx
        .select({ id: externalBookings.id })
        .from(externalBookings)
        .where(and(inArray(externalBookings.assignmentId, reconfirmations.map((r) => r.assignmentId)), inArray(externalBookings.state, ['entered_unverified', 'verified'])))
    : [];

  return {
    orderId: order.id,
    version: order.version,
    plans,
    changes: plans.flatMap((p) => p.changed),
    addedLines: input.addLines.length,
    materialLineIds,
    reconfirmations,
    staleOffers,
    excessAssignments,
    pendingMessagesToSupersede: drafts.filter((d) => ['draft', 'copied', 'queued'].includes(d.state)).length,
    sentMessagesNeedingAmendment: drafts.filter((d) => ['manually_marked_sent', 'provider_accepted', 'delivered', 'delivery_unknown', 'acknowledged'].includes(d.state)).length,
    tripsAffected: tripRows,
    externalBookingsToUpdate: ext.length,
  };
}

/** Non-mutating preview of what an amendment would change. Returns a short-lived token bound to this exact input and version. */
export async function previewAmendment(ctx: ServiceContext, orderId: string, raw: AmendmentInput): Promise<AmendmentImpact> {
  const input = amendmentSchema.parse(raw);
  return command(ctx, { operation: 'order.preview' }, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!order) throw notFound('Order');
    requireCapability(ctx.actor, 'order.amend', order.branchId);
    checkVersion(order.version, input.expectedVersion);
    const { plans: _plans, ...impact } = await computeImpact(tx, order, input);
    const expiresAt = nowOf(ctx).getTime() + 10 * 60_000;
    return { ...impact, token: signImpact(order.id, order.version, inputHash(order.id, input), expiresAt) };
  });
}

// ------------------------------------------------------------------ amendment commit

async function updateReservationsForLine(tx: Tx, ctx: ServiceContext, line: LineRow, policy: OperatingPolicy): Promise<string[]> {
  const interval = reservationInterval({ arrivalAt: line.arrivalAt, startAt: line.startAt, endAt: line.endAt, endUnknown: line.endUnknown }, policy.provisionalShiftHours);
  const active = await tx
    .select({ id: assignments.id, workerId: assignments.workerId })
    .from(assignments)
    .where(and(eq(assignments.lineId, line.id), inArray(assignments.state, ['proposed', 'offered', 'accepted', 'reconfirmation_required'])));
  const clashes: string[] = [];
  for (const a of active) {
    if (!interval) {
      await tx.update(resourceReservations).set({ active: false }).where(and(eq(resourceReservations.assignmentId, a.id), eq(resourceReservations.active, true)));
      continue;
    }
    try {
      await tx.transaction(async (sp) => {
        await sp
          .update(resourceReservations)
          .set({ during: tstzrange(interval.from, interval.to), uncertain: interval.uncertain, updatedAt: nowOf(ctx) })
          .where(and(eq(resourceReservations.assignmentId, a.id), eq(resourceReservations.active, true)));
      });
    } catch (e) {
      if (pgErrorCode(e) !== '23P01') throw e;
      // The new time clashes with another booking for this worker. Release this reservation and
      // make the clash visible rather than failing the client's amendment.
      await tx.update(resourceReservations).set({ active: false }).where(and(eq(resourceReservations.assignmentId, a.id), eq(resourceReservations.active, true)));
      clashes.push(a.id);
    }
  }
  return clashes;
}

export async function amendOrder(ctx: ServiceContext, orderId: string, raw: AmendmentInput, idempotencyKey?: string): Promise<{ revision: number; version: number; impact: Omit<AmendmentImpact, 'token'> }> {
  const input = amendmentSchema.parse(raw);
  return command(ctx, { operation: 'order.amend', idempotencyKey, input: { orderId, ...input } }, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order) throw notFound('Order');
    requireCapability(ctx.actor, 'order.amend', order.branchId);
    checkVersion(order.version, input.expectedVersion);
    if (order.requestState === 'cancelled' || order.requestState === 'closed') throw new DomainError('INVALID_STATE', 'This order is closed.');
    verifyImpactToken(input.acknowledgeImpactToken, order.id, order.version, inputHash(order.id, input), nowOf(ctx));
    await assertSourcesExist(tx, input.sourceMessageIds, order.branchId);
    await assertSitesBelongToClient(tx, order.clientId, [
      ...input.lineChanges.map((c) => c.siteId ?? null),
      ...input.addLines.map((l) => l.siteId ?? null),
    ]);
    // Lock affected lines in a consistent order before reading dependants.
    const lockIds = input.lineChanges.map((c) => c.lineId).sort();
    if (lockIds.length) await tx.select({ id: orderLines.id }).from(orderLines).where(inArray(orderLines.id, lockIds)).orderBy(asc(orderLines.id)).for('update');

    const impact = await computeImpact(tx, order, input);
    if (!impact.changes.length && !input.addLines.length) throw new DomainError('VALIDATION_FAILED', 'Nothing changed.');
    const policy = await loadPolicy(tx, order.branchId);
    const revisionNo = order.currentRevision + 1;

    for (const plan of impact.plans) {
      if (!plan.changed.length) continue;
      const t = computeLineTimes(plan.next);
      const acceptedCount = plan.line.acceptedCount === null ? null : Math.min(plan.line.acceptedCount, plan.next.requestedCount);
      const [updated] = await tx
        .update(orderLines)
        .set({
          ...plan.next,
          arrivalAt: t.arrivalAt,
          startAt: t.startAt,
          endAt: t.endAt,
          endUnknown: t.endUnknown,
          acceptedCount,
          lineVersion: plan.material ? plan.line.lineVersion + 1 : plan.line.lineVersion,
          updatedAt: nowOf(ctx),
          updatedBy: actorId(ctx.actor),
          version: plan.line.version + 1,
        })
        .where(eq(orderLines.id, plan.line.id))
        .returning();
      const line = updated!;
      const label = `${order.reference} line ${line.lineNo}`;

      if (plan.material) {
        const clashes = await updateReservationsForLine(tx, ctx, line, policy);
        for (const r of impact.reconfirmations.filter((x) => x.lineId === line.id)) {
          await tx.update(assignments).set({ state: 'reconfirmation_required', updatedAt: nowOf(ctx), version: sql`${assignments.version} + 1` }).where(eq(assignments.id, r.assignmentId));
          await createTask(tx, ctx, {
            branchId: order.branchId,
            type: 'reconfirm_worker',
            title: `Reconfirm ${r.workerName} for changed shift ${label}`,
            entityType: 'assignment',
            entityId: r.assignmentId,
            ownerMembershipId: order.ownerMembershipId,
            priority: 'high',
            dedupeKey: `reconfirm:${r.assignmentId}`,
          });
        }
        for (const s of impact.staleOffers.filter((x) => x.lineId === line.id)) {
          await createTask(tx, ctx, {
            branchId: order.branchId,
            type: 'reoffer_worker',
            title: `Re-send the updated offer to ${s.workerName} for ${label}`,
            entityType: 'assignment',
            entityId: s.assignmentId,
            ownerMembershipId: order.ownerMembershipId,
            dedupeKey: `reoffer:${s.assignmentId}`,
          });
        }
        for (const id of clashes) {
          await createTask(tx, ctx, {
            branchId: order.branchId,
            type: 'resource_clash',
            title: `New times for ${label} clash with another booking for an assigned worker`,
            entityType: 'assignment',
            entityId: id,
            ownerMembershipId: order.ownerMembershipId,
            priority: 'high',
            dedupeKey: `clash:${id}`,
          });
        }
        // Unsent instructions for the old version must not go out.
        await tx
          .update(messageDrafts)
          .set({ state: 'superseded', endedAt: nowOf(ctx), endReason: `Order revision ${revisionNo}`, version: sql`${messageDrafts.version} + 1` })
          .where(and(eq(messageDrafts.entityType, 'order_line'), eq(messageDrafts.entityId, line.id), inArray(messageDrafts.state, ['draft', 'copied', 'queued'])));
        const sent = await tx
          .select({ id: messageDrafts.id, assignmentId: messageDrafts.assignmentId })
          .from(messageDrafts)
          .where(
            and(
              eq(messageDrafts.entityType, 'order_line'),
              eq(messageDrafts.entityId, line.id),
              sql`${messageDrafts.entityRevision} < ${line.lineVersion}`,
              inArray(messageDrafts.state, ['manually_marked_sent', 'provider_accepted', 'delivered', 'delivery_unknown', 'acknowledged']),
            ),
          );
        for (const m of sent) {
          await createTask(tx, ctx, {
            branchId: order.branchId,
            type: 'send_amendment',
            title: `Send the amendment for ${label}: an earlier instruction went to this person`,
            entityType: 'message_draft',
            entityId: m.id,
            ownerMembershipId: order.ownerMembershipId,
            priority: 'high',
            dedupeKey: `send_amendment:${m.assignmentId ?? m.id}:${line.lineVersion}`,
          });
        }
      }
      for (const ex of impact.excessAssignments.filter((x) => x.lineId === line.id)) {
        await createTask(tx, ctx, {
          branchId: order.branchId,
          type: 'review_excess',
          title: `${label}: ${ex.active} people assigned but only ${ex.accepted} accepted. Decide who to release and tell them.`,
          entityType: 'order_line',
          entityId: line.id,
          ownerMembershipId: order.ownerMembershipId,
          priority: 'high',
          dedupeKey: `excess:${line.id}`,
        });
      }
    }
    for (const t of impact.tripsAffected) {
      await createTask(tx, ctx, {
        branchId: order.branchId,
        type: 'review_trip',
        title: `Review journey ${t.reference}: passengers' shift changed in ${order.reference}`,
        entityType: 'trip',
        entityId: t.tripId,
        priority: 'high',
        dedupeKey: `review_trip:${t.tripId}:${revisionNo}`,
      });
    }
    if (impact.externalBookingsToUpdate) {
      await createTask(tx, ctx, {
        branchId: order.branchId,
        type: 'update_external_booking',
        title: `Update ${impact.externalBookingsToUpdate} JoinedUp booking(s) for ${order.reference} revision ${revisionNo}`,
        entityType: 'order',
        entityId: order.id,
        ownerMembershipId: order.ownerMembershipId,
        priority: 'high',
        dedupeKey: `ju_update:${order.id}:${revisionNo}`,
      });
    }

    const [{ maxNo }] = (await tx.select({ maxNo: sql<number>`coalesce(max(${orderLines.lineNo}),0)` }).from(orderLines).where(eq(orderLines.orderId, order.id))) as [{ maxNo: number }];
    for (const [i, l] of input.addLines.entries()) await insertLine(tx, ctx, order, Number(maxNo) + i + 1, lineFieldsFromInput(l));

    const newVersion = order.version + 1;
    await tx.update(orders).set({ currentRevision: revisionNo, version: newVersion, updatedAt: nowOf(ctx), updatedBy: actorId(ctx.actor) }).where(eq(orders.id, order.id));
    await writeRevision(tx, ctx, order, revisionNo, input.reason, impact.changes, input.sourceMessageIds, 'amendment');
    await audit(tx, ctx, { action: 'order.amended', entityType: 'order', entityId: order.id, after: { revisionNo, changes: impact.changes }, reason: input.reason });
    await enqueue(tx, ctx, { eventType: 'order.amended', entityType: 'order', entityId: order.id, entityRevision: revisionNo });
    const { plans: _p, ...summary } = impact;
    return { revision: revisionNo, version: newVersion, impact: summary };
  });
}

// ------------------------------------------------------------------ acceptance

/**
 * Record the agency's decision per line: full, partial (fewer than requested) or decline (0).
 * The client's request is kept unchanged; acceptance is a separate event.
 */
export async function decideAcceptance(ctx: ServiceContext, orderId: string, raw: AcceptanceInput, idempotencyKey?: string): Promise<{ requestState: string; version: number }> {
  const input = acceptanceSchema.parse(raw);
  return command(ctx, { operation: 'order.accept', idempotencyKey, input: { orderId, ...input } }, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order) throw notFound('Order');
    requireCapability(ctx.actor, 'order.accept', order.branchId);
    checkVersion(order.version, input.expectedVersion);
    if (['cancelled', 'closed', 'declined'].includes(order.requestState)) throw new DomainError('INVALID_STATE', `This order is ${order.requestState}.`);
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, order.id)).orderBy(asc(orderLines.id)).for('update');
    const changes: LineFieldChange[] = [];
    for (const d of input.decisions) {
      const line = lines.find((l) => l.id === d.lineId);
      if (!line) throw new DomainError('VALIDATION_FAILED', 'A decision refers to a line not in this order.');
      if (line.lineState === 'cancelled') throw new DomainError('INVALID_STATE', `Line ${line.lineNo} is cancelled.`);
      if (d.acceptedCount > line.requestedCount) {
        throw new DomainError('VALIDATION_FAILED', `Line ${line.lineNo}: cannot accept more than the client requested (${line.requestedCount}) without a client amendment.`);
      }
      const active = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.lineId, line.id), inArray(assignments.state, ['proposed', 'offered', 'accepted', 'reconfirmation_required'])));
      if (active.length > d.acceptedCount) {
        await createTask(tx, ctx, {
          branchId: order.branchId,
          type: 'review_excess',
          title: `${order.reference} line ${line.lineNo}: ${active.length} people assigned but only ${d.acceptedCount} accepted. Decide who to release and tell them.`,
          entityType: 'order_line',
          entityId: line.id,
          ownerMembershipId: order.ownerMembershipId,
          priority: 'high',
          dedupeKey: `excess:${line.id}`,
        });
      }
      if (line.acceptedCount !== d.acceptedCount) changes.push({ lineId: line.id, lineNo: line.lineNo, field: 'acceptedCount', from: line.acceptedCount, to: d.acceptedCount });
      await tx.update(orderLines).set({ acceptedCount: d.acceptedCount, version: line.version + 1, updatedAt: nowOf(ctx) }).where(eq(orderLines.id, line.id));
    }
    const after = await tx.select({ requested: orderLines.requestedCount, accepted: orderLines.acceptedCount, state: orderLines.lineState }).from(orderLines).where(eq(orderLines.orderId, order.id));
    const open = after.filter((l) => l.state !== 'cancelled');
    const undecided = open.some((l) => l.accepted === null);
    const totalAccepted = open.reduce((s, l) => s + (l.accepted ?? 0), 0);
    const full = open.every((l) => l.accepted !== null && l.accepted >= l.requested);
    const requestState = undecided ? order.requestState : totalAccepted === 0 ? 'declined' : full ? 'accepted' : 'partially_accepted';
    const revisionNo = order.currentRevision + 1;
    await tx
      .update(orders)
      .set({ requestState, acceptanceNote: input.note ?? null, currentRevision: revisionNo, version: order.version + 1, updatedAt: nowOf(ctx), updatedBy: actorId(ctx.actor) })
      .where(eq(orders.id, order.id));
    await writeRevision(tx, ctx, order, revisionNo, `Agency decision: ${requestState}${input.note ? ` (${input.note})` : ''}`, changes, [], 'confirmation');
    await closeTasksByKey(tx, ctx, `late_order:${order.id}`, `Agency decision recorded: ${requestState}`);
    await audit(tx, ctx, { action: 'order.acceptance_decided', entityType: 'order', entityId: order.id, after: { requestState, decisions: input.decisions }, reason: input.note ?? null });
    await enqueue(tx, ctx, { eventType: 'order.acceptance_decided', entityType: 'order', entityId: order.id, entityRevision: revisionNo });
    return { requestState, version: order.version + 1 };
  });
}

// ------------------------------------------------------------------ conflicts

/** Record that sources disagree (e.g. client said 06:30, internal booking says 07:00). Neither value wins. */
export async function raiseConflict(ctx: ServiceContext, orderId: string, raw: RaiseConflictInput): Promise<{ id: string }> {
  const input = raiseConflictSchema.parse(raw);
  return command(ctx, { operation: 'conflict.raise' }, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!order) throw notFound('Order');
    requireCapability(ctx.actor, 'order.amend', order.branchId);
    if (input.lineId) {
      const [line] = await tx.select({ id: orderLines.id }).from(orderLines).where(and(eq(orderLines.id, input.lineId), eq(orderLines.orderId, order.id)));
      if (!line) throw new DomainError('VALIDATION_FAILED', 'Line not in this order.');
    }
    const [row] = await tx
      .insert(orderConflicts)
      .values({
        organisationId: ctx.actor.organisationId,
        orderId: order.id,
        lineId: input.lineId ?? null,
        fieldPath: input.fieldPath,
        observations: input.observations as never,
        raisedBy: actorId(ctx.actor),
        raisedAt: nowOf(ctx),
        createdBy: actorId(ctx.actor),
      })
      .returning({ id: orderConflicts.id });
    await createTask(tx, ctx, {
      branchId: order.branchId,
      type: 'resolve_conflict',
      title: `Resolve conflicting ${input.fieldPath} for ${order.reference}: ${input.observations.map((o) => o.value).join(' vs ')}`,
      entityType: 'order_conflict',
      entityId: row!.id,
      ownerMembershipId: order.ownerMembershipId,
      priority: 'high',
      dedupeKey: `conflict:${row!.id}`,
    });
    await audit(tx, ctx, { action: 'conflict.raised', entityType: 'order_conflict', entityId: row!.id, after: input });
    return { id: row!.id };
  });
}

/**
 * Resolve a conflict with an explicit decision and note. Applying the value to the order is a
 * separate amendment, so it goes through impact preview and reconfirmation like any change.
 */
export async function resolveConflict(ctx: ServiceContext, conflictId: string, raw: ResolveConflictInput): Promise<void> {
  const input = resolveConflictSchema.parse(raw);
  await command(ctx, { operation: 'conflict.resolve' }, async (tx) => {
    const [c] = await tx.select().from(orderConflicts).where(eq(orderConflicts.id, conflictId)).for('update');
    if (!c) throw notFound('Conflict');
    const [order] = await tx.select().from(orders).where(eq(orders.id, c.orderId));
    requireCapability(ctx.actor, 'conflict.resolve', order!.branchId);
    if (c.state !== 'open') throw new DomainError('INVALID_STATE', 'This conflict is already resolved.');
    await tx
      .update(orderConflicts)
      .set({ state: 'resolved', resolvedValue: input.resolvedValue as never, resolvedBy: actorId(ctx.actor), resolvedAt: nowOf(ctx), resolutionNote: input.note, version: c.version + 1 })
      .where(eq(orderConflicts.id, c.id));
    await closeTasksByKey(tx, ctx, `conflict:${c.id}`, `Resolved as ${input.resolvedValue}: ${input.note}`);
    await audit(tx, ctx, { action: 'conflict.resolved', entityType: 'order_conflict', entityId: c.id, after: input });
  });
}

// ------------------------------------------------------------------ cancellation

/**
 * Cancel a whole order, selected lines or selected assignments. Unsent instructions are
 * withdrawn; anyone already informed gets a cancellation-acknowledgement task; journeys and
 * JoinedUp bookings get follow-up tasks. A vehicle already on the road needs a dispatcher decision.
 */
export async function cancelOrder(ctx: ServiceContext, orderId: string, raw: CancellationInput, idempotencyKey?: string): Promise<{ cancelledAssignments: number; acknowledgementTasks: number; version: number }> {
  const input = cancellationSchema.parse(raw);
  return command(ctx, { operation: 'order.cancel', idempotencyKey, input: { orderId, ...input } }, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order) throw notFound('Order');
    requireCapability(ctx.actor, 'order.cancel', order.branchId);
    checkVersion(order.version, input.expectedVersion);
    if (order.requestState === 'cancelled') throw new DomainError('INVALID_STATE', 'This order is already cancelled.');
    await assertSourcesExist(tx, input.sourceMessageIds, order.branchId);

    const allLines = await tx.select().from(orderLines).where(eq(orderLines.orderId, order.id)).orderBy(asc(orderLines.id)).for('update');
    let lineIds: string[] = [];
    let assignmentIds: string[] = [];
    if (input.scope === 'order') lineIds = allLines.map((l) => l.id);
    if (input.scope === 'lines') {
      lineIds = input.lineIds ?? [];
      if (!lineIds.length || lineIds.some((id) => !allLines.find((l) => l.id === id))) throw new DomainError('VALIDATION_FAILED', 'Select lines from this order.');
    }
    if (input.scope === 'assignments') {
      assignmentIds = input.assignmentIds ?? [];
      if (!assignmentIds.length) throw new DomainError('VALIDATION_FAILED', 'Select assignments to cancel.');
    }
    const affected = await tx
      .select({ id: assignments.id, lineId: assignments.lineId, workerId: assignments.workerId, state: assignments.state, workerName: workers.displayName })
      .from(assignments)
      .innerJoin(workers, eq(workers.id, assignments.workerId))
      .where(
        and(
          eq(assignments.orderId, order.id),
          inArray(assignments.state, ['proposed', 'offered', 'accepted', 'reconfirmation_required']),
          input.scope === 'assignments' ? inArray(assignments.id, assignmentIds) : inArray(assignments.lineId, lineIds.length ? lineIds : ['00000000-0000-0000-0000-000000000000']),
        ),
      );
    if (input.scope === 'assignments' && affected.length !== assignmentIds.length) {
      throw new DomainError('VALIDATION_FAILED', 'Some selected assignments are not active on this order.');
    }

    let ackTasks = 0;
    for (const a of affected) {
      await tx.update(assignments).set({ state: 'cancelled', endReason: input.reason, updatedAt: nowOf(ctx), version: sql`${assignments.version} + 1` }).where(eq(assignments.id, a.id));
      await tx.update(resourceReservations).set({ active: false }).where(and(eq(resourceReservations.assignmentId, a.id), eq(resourceReservations.active, true)));
      await closeTasksByKey(tx, ctx, `reconfirm:${a.id}`, 'Assignment cancelled', 'cancelled');
      await closeTasksByKey(tx, ctx, `reoffer:${a.id}`, 'Assignment cancelled', 'cancelled');
    }
    const affectedIds = affected.map((a) => a.id);
    if (affectedIds.length) {
      // Withdraw anything not yet sent.
      await tx
        .update(messageDrafts)
        .set({ state: 'withdrawn', endedAt: nowOf(ctx), endReason: `Cancelled: ${input.reason}`, version: sql`${messageDrafts.version} + 1` })
        .where(and(inArray(messageDrafts.assignmentId, affectedIds), inArray(messageDrafts.state, ['draft', 'copied', 'queued'])));
      // People already told must be told it is cancelled, and that must be acknowledged.
      const informed = await tx
        .selectDistinct({ assignmentId: messageDrafts.assignmentId })
        .from(messageDrafts)
        .where(and(inArray(messageDrafts.assignmentId, affectedIds), inArray(messageDrafts.state, ['manually_marked_sent', 'provider_accepted', 'delivered', 'delivery_unknown', 'acknowledged'])));
      for (const i of informed) {
        const a = affected.find((x) => x.id === i.assignmentId)!;
        await createTask(tx, ctx, {
          branchId: order.branchId,
          type: 'cancellation_ack',
          title: `Tell ${a.workerName} that ${order.reference} is cancelled and record their acknowledgement`,
          entityType: 'assignment',
          entityId: a.id,
          ownerMembershipId: order.ownerMembershipId,
          priority: 'urgent',
          dedupeKey: `cancel_ack:${a.id}`,
        });
        ackTasks++;
      }
      await tx
        .update(transportRequirements)
        .set({ mode: 'not_required', arrangementNote: `Assignment cancelled: ${input.reason}`, updatedAt: nowOf(ctx) })
        .where(inArray(transportRequirements.assignmentId, affectedIds));
      // JoinedUp: nothing entered → nothing to do; entered/verified → someone must cancel it there.
      await tx.update(externalBookings).set({ state: 'not_required', updatedAt: nowOf(ctx) }).where(and(inArray(externalBookings.assignmentId, affectedIds), eq(externalBookings.state, 'pending_entry')));
      const entered = await tx
        .select({ id: externalBookings.id })
        .from(externalBookings)
        .where(and(inArray(externalBookings.assignmentId, affectedIds), inArray(externalBookings.state, ['entered_unverified', 'verified'])));
      for (const e of entered) {
        await createTask(tx, ctx, {
          branchId: order.branchId,
          type: 'cancel_external_booking',
          title: `Cancel the JoinedUp booking for a cancelled assignment on ${order.reference} and record the evidence`,
          entityType: 'external_booking',
          entityId: e.id,
          ownerMembershipId: order.ownerMembershipId,
          priority: 'high',
          dedupeKey: `ju_cancel:${e.id}`,
        });
      }
      const tripRows = await tx
        .selectDistinct({ tripId: trips.id, reference: trips.reference, state: trips.state })
        .from(tripPassengers)
        .innerJoin(tripRevisions, eq(tripRevisions.id, tripPassengers.tripRevisionId))
        .innerJoin(trips, and(eq(trips.id, tripRevisions.tripId), eq(trips.currentRevision, tripRevisions.revisionNo)))
        .where(and(inArray(tripPassengers.assignmentId, affectedIds), sql`${trips.state} not in ('cancelled','completed')`));
      for (const t of tripRows) {
        const travelling = t.state === 'departed';
        await createTask(tx, ctx, {
          branchId: order.branchId,
          type: travelling ? 'dispatcher_decision' : 'review_trip',
          title: travelling
            ? `Journey ${t.reference} is already travelling with passengers whose work was cancelled: dispatcher decision needed`
            : `Remove cancelled passengers from journey ${t.reference} and tell the driver`,
          entityType: 'trip',
          entityId: t.tripId,
          priority: travelling ? 'urgent' : 'high',
          dedupeKey: `cancel_trip:${t.tripId}:${order.id}`,
        });
      }
    }
    if (input.scope !== 'assignments') {
      await tx.update(orderLines).set({ lineState: 'cancelled', updatedAt: nowOf(ctx), version: sql`${orderLines.version} + 1` }).where(inArray(orderLines.id, lineIds));
    }
    const remaining = await tx.select({ id: orderLines.id }).from(orderLines).where(and(eq(orderLines.orderId, order.id), eq(orderLines.lineState, 'open')));
    const requestState = remaining.length === 0 ? 'cancelled' : order.requestState;
    const revisionNo = order.currentRevision + 1;
    await tx.update(orders).set({ requestState, currentRevision: revisionNo, version: order.version + 1, updatedAt: nowOf(ctx), updatedBy: actorId(ctx.actor) }).where(eq(orders.id, order.id));
    await writeRevision(
      tx,
      ctx,
      order,
      revisionNo,
      `Cancellation (${input.scope}): ${input.reason}`,
      [{ scope: input.scope, lineIds, assignmentIds: affectedIds }],
      input.sourceMessageIds,
      'cancellation',
    );
    await audit(tx, ctx, { action: 'order.cancelled', entityType: 'order', entityId: order.id, after: { scope: input.scope, lineIds, assignmentIds: affectedIds }, reason: input.reason });
    await enqueue(tx, ctx, { eventType: 'order.cancelled', entityType: 'order', entityId: order.id, entityRevision: revisionNo });
    return { cancelledAssignments: affected.length, acknowledgementTasks: ackTasks, version: order.version + 1 };
  });
}

/** The client says no replacement is needed for a vacancy: stop replacement searches for this line. */
export async function recordReplacementDeclined(ctx: ServiceContext, lineId: string, note: string): Promise<void> {
  await command(ctx, { operation: 'line.replacement_declined' }, async (tx) => {
    const [line] = await tx.select().from(orderLines).where(eq(orderLines.id, lineId)).for('update');
    if (!line) throw notFound('Line');
    requireCapability(ctx.actor, 'order.amend', line.branchId);
    await tx.update(orderLines).set({ replacementDeclinedAt: nowOf(ctx), version: line.version + 1 }).where(eq(orderLines.id, line.id));
    await tx
      .update(tasks)
      .set({ state: 'cancelled', outcome: `Client declined replacement: ${note}`, completedAt: nowOf(ctx), completedBy: actorId(ctx.actor) })
      .where(and(eq(tasks.entityId, line.id), eq(tasks.type, 'find_replacement'), inArray(tasks.state, ['open', 'in_progress'])));
    await audit(tx, ctx, { action: 'line.replacement_declined', entityType: 'order_line', entityId: line.id, reason: note });
  });
}
