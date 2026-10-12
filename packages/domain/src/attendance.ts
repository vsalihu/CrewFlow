// Attendance, timesheets and approved-hours export (build plan §10, Phase 2).
//
// Scheduled work (assignments), observed attendance (segments) and paid-hour approval stay separate.
// Reported work is never deleted or edited in place: corrections add a new revision of the same
// segment, and an approval or export always refers to exact revisions.

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { DomainError, addDays, formatServiceDate, isLocalDate, isLocalTime, resolveLocal } from '@cds/contracts';
import { actorId, can, requireCapability } from '@cds/auth';
import {
  assignments,
  attendanceApprovals,
  attendanceSegments,
  breakPolicies,
  cases,
  clients,
  exportBatches,
  exportRows,
  externalWorkerIds,
  orderLines,
  orders,
  sites,
  sourceMessages,
  timesheetBatches,
  workers,
  type Tx,
} from '@cds/db';
import { audit, checkVersion, command, nextReference, notFound, nowOf, read, type ServiceContext } from './context';
import { hhmm } from './lines';
import { describeIssues, evaluateReadiness } from './readiness';
import { closeTasksByKey, createTask } from './tasks';

type SegmentRow = typeof attendanceSegments.$inferSelect;
type BatchRow = typeof timesheetBatches.$inferSelect;
type PolicyRow = typeof breakPolicies.$inferSelect;

const BOOKED_STATES = ['accepted', 'reconfirmation_required', 'arrived', 'completed'];

// ------------------------------------------------------------------ arrivals

/**
 * Record whether a booked worker arrived. A no-show keeps the booking as evidence, starts a
 * replacement task (unless the client declined replacements) and never deletes anything.
 */
export async function recordArrival(
  ctx: ServiceContext,
  assignmentId: string,
  input: { status: 'arrived' | 'no_show'; note?: string | null; expectedVersion?: number },
): Promise<{ state: string; version: number }> {
  return command(ctx, { operation: 'attendance.arrival', input: { assignmentId, ...input } }, async (tx) => {
    const [a] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId)).for('update');
    if (!a) throw notFound('Assignment');
    requireCapability(ctx.actor, 'attendance.record', a.branchId);
    checkVersion(a.version, input.expectedVersion);
    // Only confirmed bookings can arrive or fail to arrive; either can be corrected if marked by mistake.
    const allowed = input.status === 'arrived' ? ['accepted', 'reconfirmation_required', 'no_show'] : ['accepted', 'reconfirmation_required', 'arrived'];
    if (!allowed.includes(a.state))
      throw new DomainError('INVALID_STATE', `This booking is ${a.state}; it cannot be marked ${input.status.replace('_', ' ')}.`);
    await tx
      .update(assignments)
      .set({ state: input.status, updatedAt: nowOf(ctx), updatedBy: actorId(ctx.actor), version: a.version + 1 })
      .where(eq(assignments.id, a.id));
    if (input.status === 'no_show') {
      const [line] = await tx.select().from(orderLines).where(eq(orderLines.id, a.lineId));
      const [w] = await tx.select({ name: workers.displayName }).from(workers).where(eq(workers.id, a.workerId));
      await tx.insert(cases).values({
        organisationId: ctx.actor.organisationId,
        branchId: a.branchId,
        type: 'no_show',
        severity: 'normal',
        summary: `${w!.name} did not arrive for ${formatServiceDate(line!.serviceDate)}`,
        affected: [{ assignmentId: a.id, workerId: a.workerId }] as never,
        restrictedNotes: input.note ?? null,
        ownerMembershipId: actorId(ctx.actor),
        createdBy: actorId(ctx.actor),
      });
      if (!line!.replacementDeclinedAt) {
        await createTask(tx, ctx, {
          branchId: a.branchId,
          type: 'find_replacement',
          title: `${w!.name} did not arrive: find a replacement or tell the client`,
          entityType: 'order_line',
          entityId: line!.id,
          priority: 'urgent',
          dedupeKey: `replace:${line!.id}:${a.id}`,
        });
      }
    } else {
      await closeTasksByKey(tx, ctx, `replace:${a.lineId}:${a.id}`, 'Worker arrived after all', 'cancelled');
    }
    await audit(tx, ctx, {
      action: `attendance.${input.status}`,
      entityType: 'assignment',
      entityId: a.id,
      before: { state: a.state },
      after: { state: input.status },
      reason: input.note ?? null,
    });
    return { state: input.status, version: a.version + 1 };
  });
}

// ------------------------------------------------------------------ break rules

export async function applicableBreakPolicy(tx: Tx, clientId: string, siteId: string, date: string): Promise<PolicyRow | null> {
  const rows = await tx
    .select()
    .from(breakPolicies)
    .where(
      and(
        eq(breakPolicies.clientId, clientId),
        lte(breakPolicies.effectiveFrom, date),
        sql`(${breakPolicies.effectiveTo} is null or ${breakPolicies.effectiveTo} >= ${date})`,
      ),
    )
    .orderBy(desc(breakPolicies.policyVersion));
  return rows.find((r) => r.siteId === siteId) ?? rows.find((r) => r.siteId === null) ?? null;
}

/** Add a new version of a client's (or site's) break rule. Old versions are kept for earlier dates. */
export async function addBreakPolicy(
  ctx: ServiceContext,
  input: {
    clientId: string;
    siteId?: string | null;
    effectiveFrom: string;
    unpaidBreakMinutes: number;
    unpaidAfterMinutes: number;
    paidBreakMinutes: number;
    agreementReference: string;
    note?: string | null;
  },
): Promise<{ id: string; policyVersion: number }> {
  requireCapability(ctx.actor, 'policy.manage');
  if (!isLocalDate(input.effectiveFrom)) throw new DomainError('VALIDATION_FAILED', 'Enter the date the rule starts.');
  for (const k of ['unpaidBreakMinutes', 'unpaidAfterMinutes', 'paidBreakMinutes'] as const) {
    if (!Number.isInteger(input[k]) || input[k] < 0 || input[k] > 24 * 60)
      throw new DomainError('VALIDATION_FAILED', 'Break minutes must be whole, non-negative numbers.');
  }
  if (!input.agreementReference.trim()) throw new DomainError('VALIDATION_FAILED', 'Record the agreement this rule comes from.');
  return command(ctx, { operation: 'break_policy.add', input }, async (tx) => {
    const [client] = await tx.select({ id: clients.id }).from(clients).where(eq(clients.id, input.clientId));
    if (!client) throw notFound('Client');
    if (input.siteId) {
      const [site] = await tx.select({ clientId: sites.clientId }).from(sites).where(eq(sites.id, input.siteId));
      if (!site || site.clientId !== input.clientId) throw new DomainError('VALIDATION_FAILED', 'The site must belong to the client.');
    }
    const [{ max }] = (await tx
      .select({ max: sql<number>`coalesce(max(${breakPolicies.policyVersion}), 0)` })
      .from(breakPolicies)
      .where(
        and(eq(breakPolicies.clientId, input.clientId), input.siteId ? eq(breakPolicies.siteId, input.siteId) : sql`${breakPolicies.siteId} is null`),
      )) as [{ max: number }];
    const [row] = await tx
      .insert(breakPolicies)
      .values({
        organisationId: ctx.actor.organisationId,
        clientId: input.clientId,
        siteId: input.siteId ?? null,
        policyVersion: Number(max) + 1,
        effectiveFrom: input.effectiveFrom,
        unpaidBreakMinutes: input.unpaidBreakMinutes,
        unpaidAfterMinutes: input.unpaidAfterMinutes,
        paidBreakMinutes: input.paidBreakMinutes,
        agreementReference: input.agreementReference.trim(),
        note: input.note ?? null,
        createdBy: actorId(ctx.actor),
      })
      .returning();
    await audit(tx, ctx, {
      action: 'break_policy.added',
      entityType: 'break_policy',
      entityId: row!.id,
      after: { ...input, policyVersion: row!.policyVersion },
    });
    return { id: row!.id, policyVersion: row!.policyVersion };
  });
}

// ------------------------------------------------------------------ segment arithmetic

export type SegmentInput = {
  workerId?: string | null;
  rawName: string;
  startLocal: string;
  endLocal: string;
  /** 1 when the shift ends after midnight. Never inferred from end < start. */
  endDayOffset?: 0 | 1;
  /** As written on the timesheet. Blank means "apply the agreed rule". */
  unpaidBreakMinutes?: number | null;
  paidBreakMinutes?: number | null;
  note?: string | null;
};

type Computed = {
  startAt: Date;
  endAt: Date;
  elapsedMinutes: number;
  unpaidBreakMinutes: number;
  paidBreakMinutes: number;
  paidMinutes: number;
  breakBasis: string;
  breakPolicyId: string | null;
};

function resolveOrThrow(date: string, time: string, label: string): Date {
  const r = resolveLocal(date, time, 'Europe/London');
  if (r.kind === 'ok') return r.instant;
  const msg =
    r.kind === 'ambiguous'
      ? `${label} ${time} on ${date} happens twice when the clocks go back. Confirm which with the supervisor.`
      : r.kind === 'nonexistent'
        ? `${label} ${time} on ${date} does not exist (clocks go forward). Confirm the time.`
        : `${label}: ${r.reason}`;
  throw new DomainError('VALIDATION_FAILED', msg);
}

/**
 * Elapsed time from real instants (correct across midnight and clock changes), minus the unpaid
 * break. Paid breaks stay inside paid time. No break is ever invented.
 */
export function computeSegment(date: string, e: SegmentInput, policy: PolicyRow | null): Computed {
  if (!isLocalTime(e.startLocal) || !isLocalTime(e.endLocal)) throw new DomainError('VALIDATION_FAILED', `${e.rawName}: enter start and finish as HH:mm.`);
  const offset = e.endDayOffset ?? 0;
  const startAt = resolveOrThrow(date, e.startLocal, `${e.rawName} start`);
  const endAt = resolveOrThrow(addDays(date, offset), e.endLocal, `${e.rawName} finish`);
  if (endAt <= startAt) {
    throw new DomainError(
      'VALIDATION_FAILED',
      offset === 0
        ? `${e.rawName}: finish is before start. If they worked past midnight, mark it as finishing the next day.`
        : `${e.rawName}: finish must be after start.`,
    );
  }
  const elapsedMinutes = Math.round((endAt.getTime() - startAt.getTime()) / 60_000);
  let unpaid: number;
  let basis: string;
  if (e.unpaidBreakMinutes !== null && e.unpaidBreakMinutes !== undefined) {
    unpaid = e.unpaidBreakMinutes;
    basis = 'reported';
  } else if (policy) {
    unpaid = elapsedMinutes >= policy.unpaidAfterMinutes ? policy.unpaidBreakMinutes : 0;
    basis = `rule v${policy.policyVersion}`;
  } else {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${e.rawName}: there is no agreed break rule for this client, so enter the unpaid break shown on the timesheet (0 if none).`,
    );
  }
  const paidBreak = e.paidBreakMinutes ?? (basis === 'reported' ? 0 : (policy?.paidBreakMinutes ?? 0));
  if (!Number.isInteger(unpaid) || unpaid < 0 || !Number.isInteger(paidBreak) || paidBreak < 0)
    throw new DomainError('VALIDATION_FAILED', `${e.rawName}: break minutes must be whole numbers.`);
  if (unpaid >= elapsedMinutes) throw new DomainError('VALIDATION_FAILED', `${e.rawName}: the unpaid break is as long as the shift.`);
  return {
    startAt,
    endAt,
    elapsedMinutes,
    unpaidBreakMinutes: unpaid,
    paidBreakMinutes: paidBreak,
    paidMinutes: elapsedMinutes - unpaid,
    breakBasis: basis,
    breakPolicyId: basis === 'reported' ? null : (policy?.id ?? null),
  };
}

/** The booking a reported worker most likely relates to: same worker, client, site and date. */
async function matchAssignment(tx: Tx, batch: { clientId: string; siteId: string; serviceDate: string }, workerId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(
      and(
        eq(assignments.workerId, workerId),
        eq(orders.clientId, batch.clientId),
        eq(orderLines.siteId, batch.siteId),
        eq(orderLines.serviceDate, batch.serviceDate),
        inArray(assignments.state, [...BOOKED_STATES, 'no_show']),
      ),
    )
    .orderBy(asc(orderLines.startAt))
    .limit(1);
  return row?.id ?? null;
}

async function insertSegment(
  tx: Tx,
  ctx: ServiceContext,
  batch: BatchRow,
  e: SegmentInput,
  key: string,
  revision: number,
  reason: string,
  status: 'active' | 'voided' = 'active',
): Promise<SegmentRow> {
  const policy = await applicableBreakPolicy(tx, batch.clientId, batch.siteId, batch.serviceDate);
  const c = computeSegment(batch.serviceDate, e, policy);
  if (e.workerId) {
    const [w] = await tx.select({ id: workers.id }).from(workers).where(eq(workers.id, e.workerId));
    if (!w) throw new DomainError('VALIDATION_FAILED', `${e.rawName}: worker not found.`);
  }
  const assignmentId = e.workerId ? await matchAssignment(tx, batch, e.workerId) : null;
  const [row] = await tx
    .insert(attendanceSegments)
    .values({
      organisationId: ctx.actor.organisationId,
      branchId: batch.branchId,
      batchId: batch.id,
      segmentKey: key,
      revision,
      status,
      workerId: e.workerId ?? null,
      rawName: e.rawName.trim(),
      assignmentId,
      siteId: batch.siteId,
      serviceDate: batch.serviceDate,
      startLocal: e.startLocal,
      endLocal: e.endLocal,
      endDayOffset: e.endDayOffset ?? 0,
      startAt: c.startAt,
      endAt: c.endAt,
      elapsedMinutes: c.elapsedMinutes,
      unpaidBreakMinutes: c.unpaidBreakMinutes,
      paidBreakMinutes: c.paidBreakMinutes,
      paidMinutes: status === 'voided' ? 0 : c.paidMinutes,
      breakBasis: c.breakBasis,
      breakPolicyId: c.breakPolicyId,
      note: e.note ?? null,
      reason,
      recordedBy: actorId(ctx.actor)!,
    })
    .returning();
  return row!;
}

// ------------------------------------------------------------------ timesheets

export type TimesheetInput = {
  branchId: string;
  clientId: string;
  siteId: string;
  serviceDate: string;
  supervisorName: string;
  /** The timesheet exactly as received (pasted text or transcribed photo). */
  rawText: string;
  receivedAt: string;
  entries: SegmentInput[];
};

/**
 * Record a supervisor's timesheet. It is attendance evidence only: it never creates or changes
 * an order, even if it arrives with today's messages.
 */
export async function recordTimesheet(ctx: ServiceContext, input: TimesheetInput, idempotencyKey?: string): Promise<{ id: string; reference: string }> {
  requireCapability(ctx.actor, 'attendance.record', input.branchId);
  if (!isLocalDate(input.serviceDate)) throw new DomainError('VALIDATION_FAILED', 'Enter the work date.');
  if (!input.supervisorName.trim()) throw new DomainError('VALIDATION_FAILED', 'Record who supplied the timesheet.');
  if (!input.rawText.trim()) throw new DomainError('VALIDATION_FAILED', 'Paste or transcribe the timesheet exactly as received.');
  if (!input.entries.length) throw new DomainError('VALIDATION_FAILED', 'Add at least one person.');
  if (input.entries.some((e) => !e.rawName.trim())) throw new DomainError('VALIDATION_FAILED', 'Every row needs the name as written on the timesheet.');
  const receivedAt = new Date(input.receivedAt);
  if (Number.isNaN(receivedAt.getTime())) throw new DomainError('VALIDATION_FAILED', 'Enter when the timesheet was received.');
  return command(ctx, { operation: 'timesheet.record', idempotencyKey, input }, async (tx) => {
    const [site] = await tx.select({ clientId: sites.clientId, branchId: sites.branchId }).from(sites).where(eq(sites.id, input.siteId));
    if (!site || site.clientId !== input.clientId) throw new DomainError('VALIDATION_FAILED', 'The site must belong to the client.');
    const [src] = await tx
      .insert(sourceMessages)
      .values({
        organisationId: ctx.actor.organisationId,
        branchId: input.branchId,
        kind: 'timesheet',
        senderLabel: input.supervisorName.trim(),
        receivedAt,
        recordedBy: actorId(ctx.actor)!,
        rawText: input.rawText,
        createdBy: actorId(ctx.actor),
      })
      .returning({ id: sourceMessages.id });
    const reference = await nextReference(tx, ctx, 'timesheet', 'TS');
    const [batch] = await tx
      .insert(timesheetBatches)
      .values({
        organisationId: ctx.actor.organisationId,
        branchId: input.branchId,
        clientId: input.clientId,
        siteId: input.siteId,
        serviceDate: input.serviceDate,
        reference,
        supervisorName: input.supervisorName.trim(),
        sourceMessageId: src!.id,
        recordedBy: actorId(ctx.actor)!,
        createdBy: actorId(ctx.actor),
      })
      .returning();
    const created: SegmentRow[] = [];
    for (const e of input.entries) created.push(await insertSegment(tx, ctx, batch!, e, randomUUID(), 1, 'As reported on the timesheet'));
    await openExceptionCases(tx, ctx, batch!, created);
    await createTask(tx, ctx, {
      branchId: input.branchId,
      type: 'approve_timesheet',
      title: `Check and approve timesheet ${reference} (${input.supervisorName.trim()}, ${formatServiceDate(input.serviceDate)})`,
      entityType: 'timesheet',
      entityId: batch!.id,
      dedupeKey: `approve_ts:${batch!.id}`,
    });
    await audit(tx, ctx, { action: 'timesheet.recorded', entityType: 'timesheet', entityId: batch!.id, after: { reference, rows: created.length } });
    return { id: batch!.id, reference };
  });
}

/** Work reported for someone blocked by readiness is recorded as it happened, and an exception case opens. */
async function openExceptionCases(tx: Tx, ctx: ServiceContext, batch: BatchRow, segments: SegmentRow[]): Promise<void> {
  const ids = [...new Set(segments.filter((s) => s.workerId && s.status === 'active').map((s) => s.workerId!))];
  if (!ids.length) return;
  const readiness = await evaluateReadiness(tx, { workerIds: ids, siteId: batch.siteId, clientId: batch.clientId, date: batch.serviceDate });
  for (const [workerId, r] of readiness) {
    if (!r.blocking.length) continue;
    const [w] = await tx.select({ name: workers.displayName }).from(workers).where(eq(workers.id, workerId));
    const [existing] = await tx
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.type, 'readiness_exception'), sql`${cases.affected} @> ${JSON.stringify([{ workerId, batchId: batch.id }])}::jsonb`));
    if (existing) continue;
    await tx.insert(cases).values({
      organisationId: ctx.actor.organisationId,
      branchId: batch.branchId,
      type: 'readiness_exception',
      severity: 'high',
      summary: `${w!.name} is reported as working on ${formatServiceDate(batch.serviceDate)} while not ready: ${describeIssues(r.blocking)}`,
      affected: [{ workerId, batchId: batch.id }] as never,
      ownerMembershipId: actorId(ctx.actor),
      createdBy: actorId(ctx.actor),
    });
  }
}

async function lockBatchForChange(tx: Tx, ctx: ServiceContext, batchId: string): Promise<BatchRow> {
  const [batch] = await tx.select().from(timesheetBatches).where(eq(timesheetBatches.id, batchId)).for('update');
  if (!batch) throw notFound('Timesheet');
  requireCapability(ctx.actor, 'attendance.record', batch.branchId);
  return batch;
}

/** After any correction an approved timesheet needs approving again; nothing already exported is altered. */
async function reopenBatch(tx: Tx, ctx: ServiceContext, batch: BatchRow, why: string): Promise<void> {
  await tx
    .update(timesheetBatches)
    .set({ state: 'submitted', version: batch.version + 1, updatedAt: nowOf(ctx), updatedBy: actorId(ctx.actor) })
    .where(eq(timesheetBatches.id, batch.id));
  await createTask(tx, ctx, {
    branchId: batch.branchId,
    type: 'approve_timesheet',
    title: `Re-approve timesheet ${batch.reference}: ${why}`,
    entityType: 'timesheet',
    entityId: batch.id,
    dedupeKey: `approve_ts:${batch.id}`,
  });
}

async function currentSegmentForUpdate(tx: Tx, segmentId: string): Promise<SegmentRow> {
  const [seg] = await tx.select().from(attendanceSegments).where(eq(attendanceSegments.id, segmentId)).for('update');
  if (!seg) throw notFound('Attendance entry');
  if (!seg.isCurrent) throw new DomainError('STALE_CONFIRMATION', 'This entry has already been corrected. Reload and correct the latest revision.');
  return seg;
}

/** Correct one reported entry: the original stays, the correction becomes the current revision. */
export async function correctSegment(
  ctx: ServiceContext,
  segmentId: string,
  input: SegmentInput & { reason: string },
): Promise<{ segmentId: string; revision: number }> {
  if (input.reason.trim().length < 5) throw new DomainError('VALIDATION_FAILED', 'Say why the entry is being corrected and on whose word.');
  return command(ctx, { operation: 'attendance.correct', input: { segmentId, ...input } }, async (tx) => {
    const seg = await currentSegmentForUpdate(tx, segmentId);
    const batch = await lockBatchForChange(tx, ctx, seg.batchId);
    await tx
      .update(attendanceSegments)
      .set({ isCurrent: false, supersededAt: nowOf(ctx) })
      .where(eq(attendanceSegments.id, seg.id));
    const next = await insertSegment(tx, ctx, batch, input, seg.segmentKey, seg.revision + 1, input.reason.trim());
    await openExceptionCases(tx, ctx, batch, [next]);
    if (batch.state !== 'submitted') await reopenBatch(tx, ctx, batch, `${seg.rawName} corrected`);
    else
      await tx
        .update(timesheetBatches)
        .set({ version: batch.version + 1, updatedAt: nowOf(ctx) })
        .where(eq(timesheetBatches.id, batch.id));
    await audit(tx, ctx, {
      action: 'attendance.corrected',
      entityType: 'attendance_segment',
      entityId: next.id,
      before: { revision: seg.revision, startLocal: seg.startLocal, endLocal: seg.endLocal, paidMinutes: seg.paidMinutes, workerId: seg.workerId },
      after: { revision: next.revision, startLocal: next.startLocal, endLocal: next.endLocal, paidMinutes: next.paidMinutes, workerId: next.workerId },
      reason: input.reason,
    });
    return { segmentId: next.id, revision: next.revision };
  });
}

/** Withdraw an entry (e.g. the same hours written on two supervisors' sheets). It stays visible as voided. */
export async function voidSegment(ctx: ServiceContext, segmentId: string, reason: string): Promise<{ segmentId: string; revision: number }> {
  if (reason.trim().length < 5) throw new DomainError('VALIDATION_FAILED', 'Say why this entry should not count.');
  return command(ctx, { operation: 'attendance.void', input: { segmentId, reason } }, async (tx) => {
    const seg = await currentSegmentForUpdate(tx, segmentId);
    if (seg.status === 'voided') throw new DomainError('INVALID_STATE', 'This entry is already voided.');
    const batch = await lockBatchForChange(tx, ctx, seg.batchId);
    await tx
      .update(attendanceSegments)
      .set({ isCurrent: false, supersededAt: nowOf(ctx) })
      .where(eq(attendanceSegments.id, seg.id));
    const next = await insertSegment(
      tx,
      ctx,
      batch,
      {
        workerId: seg.workerId,
        rawName: seg.rawName,
        startLocal: hhmm(seg.startLocal)!,
        endLocal: hhmm(seg.endLocal)!,
        endDayOffset: seg.endDayOffset as 0 | 1,
        unpaidBreakMinutes: seg.unpaidBreakMinutes,
        paidBreakMinutes: seg.paidBreakMinutes,
        note: seg.note,
      },
      seg.segmentKey,
      seg.revision + 1,
      reason.trim(),
      'voided',
    );
    if (batch.state !== 'submitted') await reopenBatch(tx, ctx, batch, `${seg.rawName} voided`);
    else
      await tx
        .update(timesheetBatches)
        .set({ version: batch.version + 1, updatedAt: nowOf(ctx) })
        .where(eq(timesheetBatches.id, batch.id));
    await audit(tx, ctx, { action: 'attendance.voided', entityType: 'attendance_segment', entityId: next.id, before: { revision: seg.revision }, reason });
    return { segmentId: next.id, revision: next.revision };
  });
}

// ------------------------------------------------------------------ discrepancies

export type Discrepancy = {
  code: 'UNKNOWN_WORKER' | 'OVERLAP' | 'NO_BOOKING' | 'DIFFERENT_SITE' | 'NO_SHOW_WITH_HOURS' | 'READINESS_BLOCKED' | 'BREAK_DIFFERS' | 'NOT_ON_TIMESHEET';
  /** block: cannot approve. review: approve only with a written justification. info: for follow-up. */
  severity: 'block' | 'review' | 'info';
  message: string;
  segmentKey?: string;
};

/** Compare a timesheet with bookings, other timesheets, readiness and the break rule. Always recomputed. */
export async function timesheetDiscrepancies(tx: Tx, batch: BatchRow): Promise<Discrepancy[]> {
  const out: Discrepancy[] = [];
  const segs = await tx
    .select()
    .from(attendanceSegments)
    .where(and(eq(attendanceSegments.batchId, batch.id), eq(attendanceSegments.isCurrent, true), eq(attendanceSegments.status, 'active')));
  const known = segs.filter((s) => s.workerId);
  for (const s of segs.filter((x) => !x.workerId)) {
    out.push({
      code: 'UNKNOWN_WORKER',
      severity: 'block',
      message: `"${s.rawName}" is not matched to a worker. Identify them or void the row.`,
      segmentKey: s.segmentKey,
    });
  }
  const workerIds = [...new Set(known.map((s) => s.workerId!))];
  if (workerIds.length) {
    // Overlapping hours for the same person anywhere (e.g. on two supervisors' sheets).
    const others = await tx
      .select({ s: attendanceSegments, ref: timesheetBatches.reference, supervisor: timesheetBatches.supervisorName })
      .from(attendanceSegments)
      .innerJoin(timesheetBatches, eq(timesheetBatches.id, attendanceSegments.batchId))
      .where(and(inArray(attendanceSegments.workerId, workerIds), eq(attendanceSegments.isCurrent, true), eq(attendanceSegments.status, 'active')));
    for (const s of known) {
      for (const o of others) {
        if (o.s.segmentKey === s.segmentKey || o.s.workerId !== s.workerId) continue;
        if (o.s.startAt < s.endAt && s.startAt < o.s.endAt) {
          out.push({
            code: 'OVERLAP',
            severity: 'block',
            message: `${s.rawName}: hours overlap with ${o.ref === batch.reference ? 'another row on this sheet' : `${o.ref} (${o.supervisor})`}. Void the duplicate or correct the times.`,
            segmentKey: s.segmentKey,
          });
        }
      }
    }
    // Bookings for these workers that day.
    const bookings = await tx
      .select({ id: assignments.id, workerId: assignments.workerId, state: assignments.state, siteId: orderLines.siteId, clientId: orders.clientId })
      .from(assignments)
      .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .where(
        and(inArray(assignments.workerId, workerIds), eq(orderLines.serviceDate, batch.serviceDate), inArray(assignments.state, [...BOOKED_STATES, 'no_show'])),
      );
    for (const s of known) {
      const linked = bookings.find((b) => b.id === s.assignmentId);
      if (linked?.state === 'no_show') {
        out.push({
          code: 'NO_SHOW_WITH_HOURS',
          severity: 'review',
          message: `${s.rawName} was recorded as a no-show but hours are reported.`,
          segmentKey: s.segmentKey,
        });
      } else if (!linked) {
        const elsewhere = bookings.find((b) => b.workerId === s.workerId);
        out.push(
          elsewhere
            ? { code: 'DIFFERENT_SITE', severity: 'review', message: `${s.rawName} was booked at a different site that day.`, segmentKey: s.segmentKey }
            : { code: 'NO_BOOKING', severity: 'review', message: `${s.rawName} has hours but no booking for this site and date.`, segmentKey: s.segmentKey },
        );
      }
    }
    const readiness = await evaluateReadiness(tx, { workerIds, siteId: batch.siteId, clientId: batch.clientId, date: batch.serviceDate });
    for (const s of known) {
      const r = readiness.get(s.workerId!);
      if (r?.blocking.length) {
        out.push({
          code: 'READINESS_BLOCKED',
          severity: 'review',
          message: `${s.rawName} worked while not ready (${describeIssues(r.blocking)}). An exception case is open.`,
          segmentKey: s.segmentKey,
        });
      }
    }
  }
  const policy = await applicableBreakPolicy(tx, batch.clientId, batch.siteId, batch.serviceDate);
  if (policy) {
    for (const s of segs.filter((x) => x.breakBasis === 'reported')) {
      const expected = s.elapsedMinutes >= policy.unpaidAfterMinutes ? policy.unpaidBreakMinutes : 0;
      if (expected !== s.unpaidBreakMinutes) {
        out.push({
          code: 'BREAK_DIFFERS',
          severity: 'review',
          message: `${s.rawName}: unpaid break ${s.unpaidBreakMinutes} min on the sheet; the agreed rule v${policy.policyVersion} gives ${expected} min.`,
          segmentKey: s.segmentKey,
        });
      }
    }
  }
  // Booked people at this client site and date who appear on no timesheet at all.
  const booked = await tx
    .select({ workerId: assignments.workerId, name: workers.displayName })
    .from(assignments)
    .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .innerJoin(workers, eq(workers.id, assignments.workerId))
    .where(
      and(
        eq(orders.clientId, batch.clientId),
        eq(orderLines.siteId, batch.siteId),
        eq(orderLines.serviceDate, batch.serviceDate),
        inArray(assignments.state, ['accepted', 'arrived', 'completed']),
      ),
    );
  if (booked.length) {
    const reported = await tx
      .select({ workerId: attendanceSegments.workerId })
      .from(attendanceSegments)
      .where(
        and(
          eq(attendanceSegments.siteId, batch.siteId),
          eq(attendanceSegments.serviceDate, batch.serviceDate),
          eq(attendanceSegments.isCurrent, true),
          eq(attendanceSegments.status, 'active'),
        ),
      );
    const seen = new Set(reported.map((r) => r.workerId));
    for (const b of booked.filter((x) => !seen.has(x.workerId))) {
      out.push({ code: 'NOT_ON_TIMESHEET', severity: 'info', message: `${b.name} was booked here but is on no timesheet for this day.` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ approval

/**
 * Approve the exact current revisions of a timesheet. The person who entered it cannot approve it.
 * Blocking discrepancies must be fixed first; review items need a written justification.
 */
export async function approveTimesheet(
  ctx: ServiceContext,
  batchId: string,
  input: { expectedVersion: number; justification?: string | null },
): Promise<{ state: string; version: number }> {
  return command(ctx, { operation: 'timesheet.approve', input: { batchId, ...input } }, async (tx) => {
    const [batch] = await tx.select().from(timesheetBatches).where(eq(timesheetBatches.id, batchId)).for('update');
    if (!batch) throw notFound('Timesheet');
    requireCapability(ctx.actor, 'attendance.approve', batch.branchId);
    checkVersion(batch.version, input.expectedVersion);
    if (batch.state === 'approved') throw new DomainError('INVALID_STATE', 'This timesheet is already approved.');
    if (batch.recordedBy === actorId(ctx.actor))
      throw new DomainError('PERMISSION_DENIED', 'Someone other than the person who entered this timesheet must approve it.');
    const found = await timesheetDiscrepancies(tx, batch);
    const blocking = found.filter((d) => d.severity === 'block');
    if (blocking.length) {
      throw new DomainError('VALIDATION_FAILED', 'Fix the blocking problems before approving.', {
        violations: blocking.map((d) => ({ code: d.code, message: d.message, subject: d.segmentKey })),
      });
    }
    const review = found.filter((d) => d.severity === 'review');
    const justification = input.justification?.trim() ?? '';
    if (review.length && justification.length < 10) {
      throw new DomainError('VALIDATION_FAILED', 'Explain why these hours should be approved despite the items listed.', {
        violations: review.map((d) => ({ code: d.code, message: d.message, subject: d.segmentKey })),
        fieldErrors: { justification: ['Required when there are items to review.'] },
      });
    }
    const segs = await tx
      .select()
      .from(attendanceSegments)
      .where(and(eq(attendanceSegments.batchId, batch.id), eq(attendanceSegments.isCurrent, true)));
    await tx.insert(attendanceApprovals).values({
      organisationId: ctx.actor.organisationId,
      batchId: batch.id,
      batchVersion: batch.version + 1,
      decision: 'approved',
      segments: segs.map((s) => ({ segmentId: s.id, segmentKey: s.segmentKey, revision: s.revision, paidMinutes: s.paidMinutes, status: s.status })) as never,
      discrepancies: review as never,
      note: justification || null,
      decidedBy: actorId(ctx.actor)!,
      decidedAt: nowOf(ctx),
    });
    await tx
      .update(timesheetBatches)
      .set({ state: 'approved', disputeNote: null, version: batch.version + 1, updatedAt: nowOf(ctx), updatedBy: actorId(ctx.actor) })
      .where(eq(timesheetBatches.id, batch.id));
    await closeTasksByKey(tx, ctx, `approve_ts:${batch.id}`, `Approved${justification ? `: ${justification}` : ''}`);
    await closeTasksByKey(tx, ctx, `dispute_ts:${batch.id}`, 'Timesheet approved after the dispute was resolved');
    await audit(tx, ctx, {
      action: 'timesheet.approved',
      entityType: 'timesheet',
      entityId: batch.id,
      after: { segments: segs.length, reviewItems: review.length },
      reason: justification || null,
    });
    return { state: 'approved', version: batch.version + 1 };
  });
}

export async function disputeTimesheet(
  ctx: ServiceContext,
  batchId: string,
  input: { expectedVersion: number; note: string },
): Promise<{ state: string; version: number }> {
  if (input.note.trim().length < 5) throw new DomainError('VALIDATION_FAILED', 'Say what is disputed and with whom.');
  return command(ctx, { operation: 'timesheet.dispute', input: { batchId, ...input } }, async (tx) => {
    const [batch] = await tx.select().from(timesheetBatches).where(eq(timesheetBatches.id, batchId)).for('update');
    if (!batch) throw notFound('Timesheet');
    requireCapability(ctx.actor, 'attendance.approve', batch.branchId);
    checkVersion(batch.version, input.expectedVersion);
    if (batch.state === 'approved') throw new DomainError('INVALID_STATE', 'This timesheet is approved. Correct an entry to reopen it.');
    const segs = await tx
      .select()
      .from(attendanceSegments)
      .where(and(eq(attendanceSegments.batchId, batch.id), eq(attendanceSegments.isCurrent, true)));
    await tx.insert(attendanceApprovals).values({
      organisationId: ctx.actor.organisationId,
      batchId: batch.id,
      batchVersion: batch.version + 1,
      decision: 'disputed',
      segments: segs.map((s) => ({ segmentId: s.id, segmentKey: s.segmentKey, revision: s.revision, paidMinutes: s.paidMinutes, status: s.status })) as never,
      note: input.note.trim(),
      decidedBy: actorId(ctx.actor)!,
      decidedAt: nowOf(ctx),
    });
    await tx
      .update(timesheetBatches)
      .set({ state: 'disputed', disputeNote: input.note.trim(), version: batch.version + 1, updatedAt: nowOf(ctx), updatedBy: actorId(ctx.actor) })
      .where(eq(timesheetBatches.id, batch.id));
    await createTask(tx, ctx, {
      branchId: batch.branchId,
      type: 'resolve_timesheet_dispute',
      title: `Resolve the dispute on timesheet ${batch.reference} with ${batch.supervisorName}`,
      entityType: 'timesheet',
      entityId: batch.id,
      priority: 'high',
      dedupeKey: `dispute_ts:${batch.id}`,
    });
    await audit(tx, ctx, { action: 'timesheet.disputed', entityType: 'timesheet', entityId: batch.id, reason: input.note });
    return { state: 'disputed', version: batch.version + 1 };
  });
}

// ------------------------------------------------------------------ export

const CSV_HEADER = [
  'export_reference',
  'row_type',
  'joinedup_worker_id',
  'worker_name',
  'client',
  'site',
  'work_date',
  'start',
  'finish',
  'unpaid_break_minutes',
  'paid_minutes',
  'timesheet',
  'segment_key',
  'segment_revision',
];

function csvCell(v: string | number): string {
  const s = String(v);
  // Neutralise spreadsheet formula injection and quote as needed.
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === 'string' ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * Generate an immutable approved-hours file for a date range. Only revisions in approved
 * timesheets are included, each exactly once. A revision exported earlier and later corrected
 * is reversed and the new revision exported, so earlier files never need to change.
 */
export async function createExport(
  ctx: ServiceContext,
  input: { branchId: string; dateFrom: string; dateTo: string },
): Promise<{ id: string; reference: string; kind: string; rowCount: number; checksum: string }> {
  requireCapability(ctx.actor, 'payroll.export', input.branchId);
  if (!isLocalDate(input.dateFrom) || !isLocalDate(input.dateTo) || input.dateTo < input.dateFrom)
    throw new DomainError('VALIDATION_FAILED', 'Choose a valid date range.');
  return command(ctx, { operation: 'export.create', input }, async (tx) => {
    // Serialise exports per branch so the same revision cannot be picked up twice.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`export:${input.branchId}`}))`);
    const approved = await tx
      .select({ s: attendanceSegments, batch: timesheetBatches, clientName: clients.displayName, siteName: sites.canonicalName })
      .from(attendanceSegments)
      .innerJoin(timesheetBatches, eq(timesheetBatches.id, attendanceSegments.batchId))
      .innerJoin(clients, eq(clients.id, timesheetBatches.clientId))
      .innerJoin(sites, eq(sites.id, timesheetBatches.siteId))
      .where(
        and(
          eq(attendanceSegments.branchId, input.branchId),
          eq(attendanceSegments.isCurrent, true),
          eq(timesheetBatches.state, 'approved'),
          gte(attendanceSegments.serviceDate, input.dateFrom),
          lte(attendanceSegments.serviceDate, input.dateTo),
        ),
      );
    const keys = approved.map((a) => a.s.segmentKey);
    const already = keys.length
      ? await tx
          .select({ row: exportRows, s: attendanceSegments })
          .from(exportRows)
          .innerJoin(attendanceSegments, eq(attendanceSegments.id, exportRows.segmentId))
          .where(inArray(exportRows.segmentKey, keys))
      : [];
    type Line = { rowType: 'hours' | 'reversal'; seg: SegmentRow; ref: string; clientName: string; siteName: string };
    const lines: Line[] = [];
    for (const a of approved) {
      const rows = already.filter((r) => r.row.segmentKey === a.s.segmentKey);
      if (rows.some((r) => r.row.segmentId === a.s.id && r.row.rowType === 'hours')) continue; // current revision already exported
      // Reverse any earlier revision whose hours were exported and not yet reversed.
      for (const r of rows.filter((x) => x.row.rowType === 'hours' && x.row.segmentId !== a.s.id)) {
        if (!rows.some((x) => x.row.segmentId === r.row.segmentId && x.row.rowType === 'reversal')) {
          lines.push({ rowType: 'reversal', seg: r.s, ref: a.batch.reference, clientName: a.clientName, siteName: a.siteName });
        }
      }
      if (a.s.status === 'active') lines.push({ rowType: 'hours', seg: a.s, ref: a.batch.reference, clientName: a.clientName, siteName: a.siteName });
    }
    if (!lines.length) throw new DomainError('VALIDATION_FAILED', 'Nothing new to export: there are no approved, unexported hours in this range.');
    const wIds = [...new Set(lines.map((l) => l.seg.workerId).filter((x): x is string => !!x))];
    const names = wIds.length ? await tx.select({ id: workers.id, name: workers.displayName }).from(workers).where(inArray(workers.id, wIds)) : [];
    const ext = wIds.length
      ? await tx
          .select()
          .from(externalWorkerIds)
          .where(and(inArray(externalWorkerIds.workerId, wIds), eq(externalWorkerIds.provider, 'joinedup')))
      : [];
    const reference = await nextReference(tx, ctx, 'export', 'EXP');
    const kind = lines.some((l) => l.rowType === 'reversal') ? 'correction' : 'hours';
    lines.sort(
      (a, b) =>
        a.seg.serviceDate.localeCompare(b.seg.serviceDate) ||
        a.ref.localeCompare(b.ref) ||
        a.seg.rawName.localeCompare(b.seg.rawName) ||
        (a.rowType === 'reversal' ? -1 : 1),
    );
    const body = lines.map((l) =>
      [
        reference,
        l.rowType,
        ext.find((e) => e.workerId === l.seg.workerId)?.externalId ?? '',
        names.find((n) => n.id === l.seg.workerId)?.name ?? l.seg.rawName,
        l.clientName,
        l.siteName,
        l.seg.serviceDate,
        hhmm(l.seg.startLocal)!,
        `${hhmm(l.seg.endLocal)}${l.seg.endDayOffset ? ' (+1 day)' : ''}`,
        l.rowType === 'reversal' ? -l.seg.unpaidBreakMinutes : l.seg.unpaidBreakMinutes,
        l.rowType === 'reversal' ? -l.seg.paidMinutes : l.seg.paidMinutes,
        l.ref,
        l.seg.segmentKey,
        l.seg.revision,
      ]
        .map(csvCell)
        .join(','),
    );
    const content = [CSV_HEADER.join(','), ...body].join('\r\n') + '\r\n';
    const checksum = createHash('sha256').update(content).digest('hex');
    const [batch] = await tx
      .insert(exportBatches)
      .values({
        organisationId: ctx.actor.organisationId,
        branchId: input.branchId,
        reference,
        kind,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        format: 'cds-approved-hours-csv-v1',
        content,
        checksum,
        rowCount: lines.length,
        destination: 'Manual download for payroll',
        createdBy: actorId(ctx.actor)!,
      })
      .returning({ id: exportBatches.id });
    for (const l of lines) {
      await tx.insert(exportRows).values({
        organisationId: ctx.actor.organisationId,
        exportBatchId: batch!.id,
        segmentId: l.seg.id,
        segmentKey: l.seg.segmentKey,
        segmentRevision: l.seg.revision,
        rowType: l.rowType,
        paidMinutes: l.rowType === 'reversal' ? -l.seg.paidMinutes : l.seg.paidMinutes,
      });
    }
    await audit(tx, ctx, {
      action: 'export.created',
      entityType: 'export_batch',
      entityId: batch!.id,
      after: { reference, kind, rowCount: lines.length, checksum },
    });
    return { id: batch!.id, reference, kind, rowCount: lines.length, checksum };
  });
}

/** Download an export file. Access is audited because it contains personal and pay-related data. */
export async function readExportFile(ctx: ServiceContext, exportId: string): Promise<{ filename: string; content: string; checksum: string }> {
  return command(ctx, { operation: 'export.read' }, async (tx) => {
    const [e] = await tx.select().from(exportBatches).where(eq(exportBatches.id, exportId));
    if (!e) throw notFound('Export');
    requireCapability(ctx.actor, 'payroll.export', e.branchId);
    await audit(tx, ctx, { action: 'export.downloaded', entityType: 'export_batch', entityId: e.id, after: { checksum: e.checksum } });
    return { filename: `${e.reference}.csv`, content: e.content, checksum: e.checksum };
  });
}

/** The receiving payroll team confirmed import. Records their reference; the file itself never changes. */
export async function acknowledgeExport(ctx: ServiceContext, exportId: string, reference: string): Promise<void> {
  if (!reference.trim()) throw new DomainError('VALIDATION_FAILED', 'Record the payroll reference or who confirmed the import.');
  await command(ctx, { operation: 'export.ack', input: { exportId, reference } }, async (tx) => {
    const [e] = await tx.select().from(exportBatches).where(eq(exportBatches.id, exportId)).for('update');
    if (!e) throw notFound('Export');
    requireCapability(ctx.actor, 'payroll.export', e.branchId);
    if (e.state === 'acknowledged') throw new DomainError('INVALID_STATE', 'This export is already acknowledged.');
    await tx
      .update(exportBatches)
      .set({ state: 'acknowledged', acknowledgedAt: nowOf(ctx), acknowledgedBy: actorId(ctx.actor), acknowledgementReference: reference.trim() })
      .where(eq(exportBatches.id, e.id));
    await audit(tx, ctx, { action: 'export.acknowledged', entityType: 'export_batch', entityId: e.id, reason: reference.trim() });
  });
}

// ------------------------------------------------------------------ read models

/** Booked people for a day with their arrival state, and the day's timesheets. */
export async function attendanceDay(ctx: ServiceContext, q: { branchId: string; date: string }) {
  requireCapability(ctx.actor, 'attendance.record', q.branchId);
  return read(ctx, async (tx) => {
    const booked = await tx
      .select({
        assignmentId: assignments.id,
        version: assignments.version,
        state: assignments.state,
        workerName: workers.displayName,
        reference: orders.reference,
        lineNo: orderLines.lineNo,
        orderId: orders.id,
        clientName: clients.displayName,
        siteName: sites.canonicalName,
        arrivalAt: orderLines.arrivalAt,
        startAt: orderLines.startAt,
      })
      .from(assignments)
      .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .innerJoin(clients, eq(clients.id, orders.clientId))
      .innerJoin(workers, eq(workers.id, assignments.workerId))
      .leftJoin(sites, eq(sites.id, orderLines.siteId))
      .where(and(eq(orderLines.branchId, q.branchId), eq(orderLines.serviceDate, q.date), inArray(assignments.state, [...BOOKED_STATES, 'no_show'])))
      .orderBy(asc(orderLines.arrivalAt), asc(workers.displayName));
    const batches = await tx
      .select({ b: timesheetBatches, clientName: clients.displayName, siteName: sites.canonicalName })
      .from(timesheetBatches)
      .innerJoin(clients, eq(clients.id, timesheetBatches.clientId))
      .innerJoin(sites, eq(sites.id, timesheetBatches.siteId))
      .where(and(eq(timesheetBatches.branchId, q.branchId), eq(timesheetBatches.serviceDate, q.date)))
      .orderBy(asc(timesheetBatches.reference));
    const withChecks = [];
    for (const b of batches) {
      const d = await timesheetDiscrepancies(tx, b.b);
      withChecks.push({ ...b, blocking: d.filter((x) => x.severity === 'block').length, review: d.filter((x) => x.severity === 'review').length });
    }
    return { booked, batches: withChecks };
  });
}

export async function getTimesheet(ctx: ServiceContext, batchId: string) {
  return read(ctx, async (tx) => {
    const [b] = await tx
      .select({ b: timesheetBatches, clientName: clients.displayName, siteName: sites.canonicalName, source: sourceMessages })
      .from(timesheetBatches)
      .innerJoin(clients, eq(clients.id, timesheetBatches.clientId))
      .innerJoin(sites, eq(sites.id, timesheetBatches.siteId))
      .innerJoin(sourceMessages, eq(sourceMessages.id, timesheetBatches.sourceMessageId))
      .where(eq(timesheetBatches.id, batchId));
    if (!b) throw notFound('Timesheet');
    requireCapability(ctx.actor, 'attendance.record', b.b.branchId);
    const segments = await tx
      .select({ s: attendanceSegments, workerName: workers.displayName })
      .from(attendanceSegments)
      .leftJoin(workers, eq(workers.id, attendanceSegments.workerId))
      .where(eq(attendanceSegments.batchId, batchId))
      .orderBy(asc(attendanceSegments.rawName), asc(attendanceSegments.revision));
    const exported = segments.length
      ? await tx
          .select({ segmentId: exportRows.segmentId, rowType: exportRows.rowType, reference: exportBatches.reference })
          .from(exportRows)
          .innerJoin(exportBatches, eq(exportBatches.id, exportRows.exportBatchId))
          .where(
            inArray(
              exportRows.segmentId,
              segments.map((s) => s.s.id),
            ),
          )
      : [];
    const approvals = await tx.select().from(attendanceApprovals).where(eq(attendanceApprovals.batchId, batchId)).orderBy(desc(attendanceApprovals.decidedAt));
    const discrepancies = await timesheetDiscrepancies(tx, b.b);
    const policy = await applicableBreakPolicy(tx, b.b.clientId, b.b.siteId, b.b.serviceDate);
    return { ...b, segments: segments.map((s) => ({ ...s, exports: exported.filter((e) => e.segmentId === s.s.id) })), approvals, discrepancies, policy };
  });
}

export async function listExports(ctx: ServiceContext, branchId: string) {
  requireCapability(ctx.actor, 'payroll.export', branchId);
  return read(ctx, (tx) =>
    tx
      .select({
        id: exportBatches.id,
        reference: exportBatches.reference,
        kind: exportBatches.kind,
        dateFrom: exportBatches.dateFrom,
        dateTo: exportBatches.dateTo,
        rowCount: exportBatches.rowCount,
        checksum: exportBatches.checksum,
        createdAt: exportBatches.createdAt,
        state: exportBatches.state,
        acknowledgementReference: exportBatches.acknowledgementReference,
      })
      .from(exportBatches)
      .where(eq(exportBatches.branchId, branchId))
      .orderBy(desc(exportBatches.createdAt)),
  );
}

export async function listBreakPolicies(ctx: ServiceContext) {
  // People who enter timesheets need to see the rules; administrators who set them may not record attendance.
  if (!can(ctx.actor, 'policy.manage')) requireCapability(ctx.actor, 'attendance.record');
  return read(ctx, (tx) =>
    tx
      .select({ p: breakPolicies, clientName: clients.displayName, siteName: sites.canonicalName })
      .from(breakPolicies)
      .innerJoin(clients, eq(clients.id, breakPolicies.clientId))
      .leftJoin(sites, eq(sites.id, breakPolicies.siteId))
      .orderBy(asc(clients.displayName), desc(breakPolicies.policyVersion)),
  );
}

/** Workers for timesheet row matching: everyone booked in the branch that day first, then the rest. */
export async function timesheetWorkerOptions(ctx: ServiceContext, q: { branchId: string; date: string }) {
  requireCapability(ctx.actor, 'attendance.record', q.branchId);
  return read(ctx, async (tx) => {
    const all = await tx
      .select({ id: workers.id, name: workers.displayName })
      .from(workers)
      .where(ne(workers.status, 'inactive'))
      .orderBy(asc(workers.displayName));
    const bookedRows = await tx
      .select({ workerId: assignments.workerId })
      .from(assignments)
      .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
      .where(and(eq(orderLines.branchId, q.branchId), eq(orderLines.serviceDate, q.date), inArray(assignments.state, [...BOOKED_STATES, 'no_show'])));
    const booked = new Set(bookedRows.map((r) => r.workerId));
    return all.map((w) => ({ ...w, booked: booked.has(w.id) })).sort((a, b) => Number(b.booked) - Number(a.booked) || a.name.localeCompare(b.name));
  });
}
