import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  DomainError,
  formatServiceDate,
  proposeAssignmentsSchema,
  workerResponseSchema,
  type ProposeAssignmentsInput,
  type Violation,
  type WorkerResponseInput,
} from '@cds/contracts';
import { actorId, requireCapability } from '@cds/auth';
import {
  assignmentResponses,
  assignments,
  clients,
  externalBookings,
  orderLines,
  orders,
  resourceReservations,
  sites,
  transportRequirements,
  workerAvailability,
  workers,
  type Tx,
} from '@cds/db';
import { audit, command, enqueue, notFound, nowOf, read, translateDbError, type ServiceContext } from './context';
import { hhmm, reservationInterval, tstzrange } from './lines';
import { loadPolicy } from './orders';
import { describeIssues, evaluateReadiness, workersWithSkill, type ReadinessResult } from './readiness';
import { closeTasksByKey, createTask } from './tasks';

type LineRow = typeof orderLines.$inferSelect;

export type CandidateExclusion = { code: Violation['code']; message: string };
export type Candidate = {
  workerId: string;
  displayName: string;
  externalIds: string[];
  eligible: boolean;
  exclusions: CandidateExclusion[];
  warnings: string[];
  /** Soft, explained information only. The coordinator chooses; there is no hidden score. */
  notes: string[];
};

type LineContext = { line: LineRow; order: typeof orders.$inferSelect; clientId: string; interval: { from: Date; to: Date; uncertain: boolean } | null };

async function lineContext(tx: Tx, lineId: string, lock = false): Promise<LineContext> {
  const q = tx.select().from(orderLines).where(eq(orderLines.id, lineId));
  const [line] = lock ? await q.for('update') : await q;
  if (!line) throw notFound('Shift line');
  const [order] = await tx.select().from(orders).where(eq(orders.id, line.orderId));
  const policy = await loadPolicy(tx, line.branchId);
  const interval = reservationInterval(
    { arrivalAt: line.arrivalAt, startAt: line.startAt, endAt: line.endAt, endUnknown: line.endUnknown },
    policy.provisionalShiftHours,
  );
  return { line, order: order!, clientId: order!.clientId, interval };
}

/**
 * Hard-filter checks for a set of workers against one line. Returns per-worker exclusions
 * (each with a plain-English reason) and warnings.
 */
async function checkWorkers(tx: Tx, lc: LineContext, workerIds: string[]): Promise<Map<string, { exclusions: CandidateExclusion[]; warnings: string[]; readiness: ReadinessResult }>> {
  const { line, interval } = lc;
  const out = new Map<string, { exclusions: CandidateExclusion[]; warnings: string[]; readiness: ReadinessResult }>();
  const ws = await tx.select().from(workers).where(inArray(workers.id, workerIds));
  for (const id of workerIds) out.set(id, { exclusions: [], warnings: [], readiness: { blocking: [], warnings: [] } });
  for (const id of workerIds) if (!ws.find((w) => w.id === id)) out.get(id)!.exclusions.push({ code: 'NOT_FOUND', message: 'Worker not found.' });

  for (const w of ws) {
    const r = out.get(w.id)!;
    if (w.status !== 'active') r.exclusions.push({ code: 'WORKER_UNAVAILABLE', message: `Worker status is ${w.status}.` });
    const latest = hhmm(w.latestFinishLocal);
    const endLocal = hhmm(line.endLocal);
    if (latest) {
      if (endLocal && (line.endDayOffset > 0 || endLocal > latest)) {
        r.exclusions.push({ code: 'WORKER_UNAVAILABLE', message: `Must leave by ${latest}; this shift ends at ${endLocal}${line.endDayOffset ? ' the next day' : ''}.` });
      } else if (!endLocal) {
        r.warnings.push(`Must leave by ${latest}; the finish time is not known yet.`);
      }
    }
    const earliest = hhmm(w.earliestStartLocal);
    const arrival = hhmm(line.arrivalLocal) ?? hhmm(line.startLocal);
    if (earliest && arrival && arrival < earliest) {
      r.exclusions.push({ code: 'WORKER_UNAVAILABLE', message: `Cannot start before ${earliest}; arrival is ${arrival}.` });
    }
  }

  const active = await tx
    .select({ workerId: assignments.workerId })
    .from(assignments)
    .where(and(eq(assignments.lineId, line.id), inArray(assignments.workerId, workerIds), inArray(assignments.state, ['proposed', 'offered', 'accepted', 'reconfirmation_required', 'arrived'])));
  const onLine = new Set(active.map((a) => a.workerId));
  for (const id of onLine) out.get(id)!.exclusions.push({ code: 'VALIDATION_FAILED', message: 'Already on this shift line.' });

  if (interval) {
    const range = tstzrange(interval.from, interval.to);
    const clashes = await tx
      .select({ resourceId: resourceReservations.resourceId, uncertain: resourceReservations.uncertain })
      .from(resourceReservations)
      .where(
        and(
          eq(resourceReservations.resourceType, 'worker'),
          inArray(resourceReservations.resourceId, workerIds),
          eq(resourceReservations.active, true),
          sql`${resourceReservations.during} && ${range}::tstzrange`,
        ),
      );
    for (const c of clashes) {
      if (onLine.has(c.resourceId)) continue; // their own reservation for this line
      out.get(c.resourceId)?.exclusions.push({
        code: 'RESOURCE_CONFLICT',
        message: c.uncertain ? 'Booked on another shift whose finish time is unknown and may overlap.' : 'Booked on another shift at an overlapping time.',
      });
    }
    const unavailable = await tx
      .select({ workerId: workerAvailability.workerId, note: workerAvailability.note })
      .from(workerAvailability)
      .where(and(inArray(workerAvailability.workerId, workerIds), eq(workerAvailability.kind, 'unavailable'), sql`${workerAvailability.during} && ${range}::tstzrange`));
    for (const u of unavailable) out.get(u.workerId)!.exclusions.push({ code: 'WORKER_UNAVAILABLE', message: `Marked unavailable${u.note ? `: ${u.note}` : ''}.` });
    if (interval.uncertain) for (const id of workerIds) out.get(id)!.warnings.push('Finish time unknown: a provisional interval is reserved.');
  }

  if (line.requiredSkill) {
    const have = await workersWithSkill(tx, workerIds, line.requiredSkill, line.serviceDate);
    for (const id of workerIds) if (!have.has(id)) out.get(id)!.exclusions.push({ code: 'VALIDATION_FAILED', message: `No current ${line.requiredSkill} skill on record.` });
  }

  const readiness = await evaluateReadiness(tx, { workerIds, siteId: line.siteId, clientId: lc.clientId, date: line.serviceDate });
  for (const [id, res] of readiness) {
    const r = out.get(id)!;
    r.readiness = res;
    if (res.blocking.length) r.exclusions.push({ code: 'READINESS_BLOCKED', message: `Not ready: ${describeIssues(res.blocking)}.` });
    if (res.warnings.length) r.warnings.push(`Check: ${describeIssues(res.warnings)}.`);
  }
  return out;
}

/** Eligible workers for a line, with every exclusion explained. Sorted by name; no opaque ranking. */
export async function listCandidates(ctx: ServiceContext, lineId: string, opts: { search?: string; limit?: number } = {}): Promise<Candidate[]> {
  requireCapability(ctx.actor, 'assignment.propose');
  return read(ctx, async (tx) => {
    const lc = await lineContext(tx, lineId);
    const search = opts.search?.trim();
    const ws = await tx
      .select({ id: workers.id, displayName: workers.displayName })
      .from(workers)
      .where(
        and(
          eq(workers.status, 'active'),
          search
            ? sql`(${workers.displayName} ilike ${'%' + search + '%'} or exists (select 1 from app.external_worker_ids e where e.worker_id = ${workers.id} and e.external_id = ${search}) or exists (select 1 from app.worker_aliases a where a.worker_id = ${workers.id} and a.alias ilike ${'%' + search + '%'}))`
            : undefined,
        ),
      )
      .orderBy(asc(workers.displayName))
      .limit(opts.limit ?? 200);
    const ids = ws.map((w) => w.id);
    if (!ids.length) return [];
    const checks = await checkWorkers(tx, lc, ids);
    const ext = await tx.execute(sql`select worker_id, external_id from app.external_worker_ids where worker_id = any(${`{${ids.join(',')}}`}::uuid[])`);
    const history = lc.line.siteId
      ? await tx.execute(sql`
          select a.worker_id, count(*)::int as n from app.assignments a join app.order_lines l on l.id = a.line_id
          where l.site_id = ${lc.line.siteId} and a.state in ('accepted','arrived','completed') and l.service_date < ${lc.line.serviceDate}
            and a.worker_id = any(${`{${ids.join(',')}}`}::uuid[])
          group by a.worker_id`)
      : { rows: [] };
    return ws.map((w) => {
      const c = checks.get(w.id)!;
      const past = (history.rows as { worker_id: string; n: number }[]).find((h) => h.worker_id === w.id);
      return {
        workerId: w.id,
        displayName: w.displayName,
        externalIds: (ext.rows as { worker_id: string; external_id: string }[]).filter((e) => e.worker_id === w.id).map((e) => e.external_id),
        eligible: c.exclusions.length === 0,
        exclusions: c.exclusions,
        warnings: c.warnings,
        notes: past ? [`Has worked at this site ${past.n} time(s) before.`] : [],
      };
    });
  });
}

/**
 * Propose workers for a line. Proposal is not acceptance: it reserves the slot and the
 * worker's time so two coordinators cannot both commit the same person. Capacity is checked
 * against the agency-accepted count under a lock on the line.
 */
export async function proposeAssignments(ctx: ServiceContext, lineId: string, raw: ProposeAssignmentsInput, idempotencyKey?: string): Promise<{ assignmentIds: string[] }> {
  const input = proposeAssignmentsSchema.parse(raw);
  return command(ctx, { operation: 'assignment.propose', idempotencyKey, input: { lineId, ...input } }, async (tx) => {
    const lc = await lineContext(tx, lineId, true);
    const { line, order } = lc;
    requireCapability(ctx.actor, 'assignment.propose', line.branchId);
    if (line.lineState !== 'open' || ['cancelled', 'closed', 'declined'].includes(order.requestState)) throw new DomainError('INVALID_STATE', 'This shift line is not open.');
    if (line.acceptedCount === null) throw new DomainError('INVALID_STATE', 'Record how many the agency accepts for this line before assigning workers.');
    if (!lc.interval) throw new DomainError('VALIDATION_FAILED', 'The start time is not resolved yet, so workers cannot be reserved.');

    const ids = input.workers.map((w) => w.workerId);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) throw new DomainError('VALIDATION_FAILED', 'The same worker appears more than once in this request.', { violations: dupes.map((d) => ({ code: 'VALIDATION_FAILED', message: 'Duplicate worker', subject: d })) });

    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(assignments)
      .where(and(eq(assignments.lineId, line.id), inArray(assignments.state, ['proposed', 'offered', 'accepted', 'reconfirmation_required', 'arrived'])))) as [{ n: number }];
    if (n + ids.length > line.acceptedCount) {
      throw new DomainError('CAPACITY_EXCEEDED', `Only ${Math.max(0, line.acceptedCount - n)} place(s) left: ${line.acceptedCount} accepted, ${n} already assigned.`);
    }

    const checks = await checkWorkers(tx, lc, ids);
    const violations: Violation[] = [];
    for (const [id, c] of checks) for (const e of c.exclusions) violations.push({ code: e.code, message: e.message, subject: id });
    if (violations.length) {
      const code = violations.some((v) => v.code === 'READINESS_BLOCKED')
        ? 'READINESS_BLOCKED'
        : violations.some((v) => v.code === 'RESOURCE_CONFLICT')
          ? 'RESOURCE_CONFLICT'
          : violations.some((v) => v.code === 'WORKER_UNAVAILABLE')
            ? 'WORKER_UNAVAILABLE'
            : 'VALIDATION_FAILED';
      throw new DomainError(code, 'Some workers cannot be proposed for this shift.', { violations });
    }

    const policy = await loadPolicy(tx, line.branchId);
    const created: string[] = [];
    try {
      for (const w of input.workers) {
        const [a] = await tx
          .insert(assignments)
          .values({
            organisationId: ctx.actor.organisationId,
            branchId: line.branchId,
            orderId: line.orderId,
            lineId: line.id,
            workerId: w.workerId,
            state: 'proposed',
            offeredLineVersion: line.lineVersion,
            offerExpiresAt: new Date(nowOf(ctx).getTime() + policy.offerExpiryHours * 3_600_000),
            proposedBy: actorId(ctx.actor),
            // Preserved exactly; "OWN" is not evidence that this person drives or has seats.
            rawTransportLabel: w.rawTransportLabel ?? null,
            createdBy: actorId(ctx.actor),
          })
          .returning({ id: assignments.id });
        await tx.insert(resourceReservations).values({
          organisationId: ctx.actor.organisationId,
          resourceType: 'worker',
          resourceId: w.workerId,
          during: tstzrange(lc.interval.from, lc.interval.to),
          uncertain: lc.interval.uncertain,
          assignmentId: a!.id,
          createdBy: actorId(ctx.actor),
        });
        created.push(a!.id);
      }
    } catch (e) {
      translateDbError(e);
    }
    await audit(tx, ctx, { action: 'assignment.proposed', entityType: 'order_line', entityId: line.id, after: { assignmentIds: created, workers: ids } });
    return { assignmentIds: created };
  });
}

/**
 * Record a worker's response to a specific line version. Every response is kept as evidence.
 * A response to an older version is stale and does not confirm the current shift.
 */
export async function recordWorkerResponse(
  ctx: ServiceContext,
  assignmentId: string,
  raw: WorkerResponseInput,
  idempotencyKey?: string,
): Promise<{ outcome: 'applied' | 'stale' | 'blocked_readiness' | 'ambiguous'; state: string }> {
  const input = workerResponseSchema.parse(raw);
  return command(ctx, { operation: 'assignment.response', idempotencyKey, input: { assignmentId, ...input } }, async (tx) => {
    const [a] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId)).for('update');
    if (!a) throw notFound('Assignment');
    requireCapability(ctx.actor, 'assignment.record_response', a.branchId);
    const lc = await lineContext(tx, a.lineId, true);
    const { line, order } = lc;
    const [worker] = await tx.select().from(workers).where(eq(workers.id, a.workerId));
    if (!['proposed', 'offered', 'accepted', 'reconfirmation_required'].includes(a.state)) {
      throw new DomainError('INVALID_STATE', `This assignment is ${a.state}.`);
    }

    let outcome: 'applied' | 'stale' | 'blocked_readiness' | 'ambiguous' = 'applied';
    let state = a.state;
    const label = `${order.reference} line ${line.lineNo} (${formatServiceDate(line.serviceDate)})`;

    if (input.response === 'ambiguous') {
      outcome = 'ambiguous';
      await createTask(tx, ctx, {
        branchId: a.branchId,
        type: 'clarify_response',
        title: `Clarify ${worker!.displayName}'s reply for ${label}: it could refer to more than one request`,
        entityType: 'assignment',
        entityId: a.id,
        ownerMembershipId: order.ownerMembershipId,
        dedupeKey: `clarify_response:${a.id}`,
      });
    } else if (input.lineVersion !== line.lineVersion) {
      outcome = 'stale';
      await createTask(tx, ctx, {
        branchId: a.branchId,
        type: 'reconfirm_worker',
        title: `${worker!.displayName} replied to an older version of ${label}: confirm the current details`,
        entityType: 'assignment',
        entityId: a.id,
        ownerMembershipId: order.ownerMembershipId,
        priority: 'high',
        dedupeKey: `reconfirm:${a.id}`,
      });
    } else if (input.response === 'accepted') {
      const readiness = (await evaluateReadiness(tx, { workerIds: [a.workerId], siteId: line.siteId, clientId: order.clientId, date: line.serviceDate })).get(a.workerId)!;
      const [reservation] = await tx
        .select({ id: resourceReservations.id })
        .from(resourceReservations)
        .where(and(eq(resourceReservations.assignmentId, a.id), eq(resourceReservations.active, true)));
      if (!reservation) {
        throw new DomainError('RESOURCE_CONFLICT', 'This worker no longer has a valid reservation for this shift (it clashed after a change). Resolve the clash first.');
      }
      if (readiness.blocking.length) {
        outcome = 'blocked_readiness';
        await createTask(tx, ctx, {
          branchId: a.branchId,
          type: 'readiness_review',
          title: `${worker!.displayName} accepted ${label} but is not ready: ${describeIssues(readiness.blocking)}. Authorised review needed before confirmation.`,
          entityType: 'assignment',
          entityId: a.id,
          priority: 'high',
          dedupeKey: `readiness:${a.id}`,
        });
      } else {
        state = 'accepted';
        await tx
          .update(assignments)
          .set({ state, acceptedLineVersion: line.lineVersion, updatedAt: nowOf(ctx), version: a.version + 1 })
          .where(eq(assignments.id, a.id));
        await closeTasksByKey(tx, ctx, `reconfirm:${a.id}`, `Worker accepted version ${line.lineVersion} by ${input.channel}`);
        await closeTasksByKey(tx, ctx, `reoffer:${a.id}`, `Worker accepted version ${line.lineVersion} by ${input.channel}`);
        for (const leg of ['outbound', 'return'] as const) {
          await tx
            .insert(transportRequirements)
            .values({ organisationId: ctx.actor.organisationId, assignmentId: a.id, leg, mode: 'unresolved', rawLabel: a.rawTransportLabel, createdBy: actorId(ctx.actor) })
            .onConflictDoNothing();
        }
        const [client] = await tx.select({ requires: clients.requiresExternalBooking }).from(clients).where(eq(clients.id, order.clientId));
        if (client?.requires) {
          await tx
            .insert(externalBookings)
            .values({ organisationId: ctx.actor.organisationId, branchId: a.branchId, assignmentId: a.id, provider: 'joinedup', state: 'pending_entry', lineVersion: line.lineVersion, createdBy: actorId(ctx.actor) })
            .onConflictDoNothing();
        }
        await enqueue(tx, ctx, { eventType: 'assignment.accepted', entityType: 'assignment', entityId: a.id, entityRevision: line.lineVersion });
      }
    } else if (input.response === 'declined') {
      state = 'declined';
      await tx.update(assignments).set({ state, endReason: 'Worker declined', updatedAt: nowOf(ctx), version: a.version + 1 }).where(eq(assignments.id, a.id));
      await tx.update(resourceReservations).set({ active: false }).where(and(eq(resourceReservations.assignmentId, a.id), eq(resourceReservations.active, true)));
      await tx.update(transportRequirements).set({ mode: 'not_required', arrangementNote: 'Worker declined' }).where(eq(transportRequirements.assignmentId, a.id));
      await closeTasksByKey(tx, ctx, `reconfirm:${a.id}`, 'Worker declined', 'cancelled');
      if (!line.replacementDeclinedAt) {
        await createTask(tx, ctx, {
          branchId: a.branchId,
          type: 'find_replacement',
          title: `${worker!.displayName} declined ${label}: find a replacement or tell the client`,
          entityType: 'order_line',
          entityId: line.id,
          ownerMembershipId: order.ownerMembershipId,
          priority: 'high',
          dedupeKey: `replace:${line.id}:${a.id}`,
        });
      }
    }

    await tx.insert(assignmentResponses).values({
      organisationId: ctx.actor.organisationId,
      assignmentId: a.id,
      lineVersion: input.lineVersion,
      response: input.response,
      channel: input.channel,
      respondedAt: new Date(input.respondedAt),
      recordedBy: actorId(ctx.actor) ?? a.proposedBy!,
      evidenceNote: input.evidenceNote ?? null,
      outcome,
    });
    await audit(tx, ctx, { action: 'assignment.response_recorded', entityType: 'assignment', entityId: a.id, before: { state: a.state }, after: { state, outcome, response: input.response, lineVersion: input.lineVersion } });
    return { outcome, state };
  });
}

/** Release a proposed/offered/accepted worker from a line (e.g. reduced acceptance), with a reason. */
export async function releaseAssignment(ctx: ServiceContext, assignmentId: string, reason: string): Promise<void> {
  await command(ctx, { operation: 'assignment.release' }, async (tx) => {
    const [a] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId)).for('update');
    if (!a) throw notFound('Assignment');
    requireCapability(ctx.actor, 'assignment.propose', a.branchId);
    if (!['proposed', 'offered', 'accepted', 'reconfirmation_required'].includes(a.state)) throw new DomainError('INVALID_STATE', `This assignment is ${a.state}.`);
    await tx.update(assignments).set({ state: 'cancelled', endReason: reason, updatedAt: nowOf(ctx), version: a.version + 1 }).where(eq(assignments.id, a.id));
    await tx.update(resourceReservations).set({ active: false }).where(and(eq(resourceReservations.assignmentId, a.id), eq(resourceReservations.active, true)));
    if (a.state === 'accepted' || a.state === 'reconfirmation_required' || a.state === 'offered') {
      const [w] = await tx.select({ name: workers.displayName }).from(workers).where(eq(workers.id, a.workerId));
      await createTask(tx, ctx, {
        branchId: a.branchId,
        type: 'cancellation_ack',
        title: `Tell ${w!.name} they are no longer needed and record their acknowledgement`,
        entityType: 'assignment',
        entityId: a.id,
        priority: 'high',
        dedupeKey: `cancel_ack:${a.id}`,
      });
    }
    await audit(tx, ctx, { action: 'assignment.released', entityType: 'assignment', entityId: a.id, before: { state: a.state }, reason });
  });
}

export async function getAssignment(tx: Tx, id: string) {
  const [row] = await tx
    .select({ a: assignments, workerName: workers.displayName, siteName: sites.canonicalName })
    .from(assignments)
    .innerJoin(workers, eq(workers.id, assignments.workerId))
    .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
    .leftJoin(sites, eq(sites.id, orderLines.siteId))
    .where(and(eq(assignments.id, id), ne(assignments.state, 'superseded')));
  return row ?? null;
}
