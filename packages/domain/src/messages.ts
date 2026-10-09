import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { DomainError, draftMessageSchema, manualSentSchema, type DraftMessageInput, type ManualSentInput } from '@cds/contracts';
import { actorId, requireCapability } from '@cds/auth';
import {
  assignments,
  contactPoints,
  drivers,
  integrationSettings,
  messageDrafts,
  orderConflicts,
  orderLines,
  orderRevisions,
  orders,
  sites,
  transportRequirements,
  tripPassengers,
  tripRevisions,
  tripStops,
  trips,
  vehicles,
  workLocations,
  workers,
  type Tx,
} from '@cds/db';
import { audit, checkVersion, command, enqueue, notFound, nowOf, type ServiceContext } from './context';
import { TEMPLATE_VERSIONS, amendment, cancellation, driverManifest, workerBooking, workerOffer, type ShiftFacts } from './templates';
import { closeTasksByKey } from './tasks';

type DraftRow = typeof messageDrafts.$inferSelect;
const SENT_STATES = ['manually_marked_sent', 'provider_accepted', 'delivered', 'delivery_unknown', 'acknowledged'];

async function verifiedContact(tx: Tx, who: { workerId?: string; driverId?: string }) {
  const [c] = await tx
    .select()
    .from(contactPoints)
    .where(
      and(
        who.workerId ? eq(contactPoints.workerId, who.workerId) : eq(contactPoints.driverId, who.driverId!),
        eq(contactPoints.status, 'active'),
        isNotNull(contactPoints.verifiedAt),
      ),
    )
    .orderBy(desc(contactPoints.verifiedAt))
    .limit(1);
  return c ?? null;
}

function transportText(r: { mode: string; tripRef: string | null; note: string | null } | undefined): string {
  if (!r) return 'not arranged yet: we will contact you';
  if (r.mode === 'agency_trip') return `agency transport${r.tripRef ? ` (${r.tripRef})` : ''}: details from your driver`;
  if (r.mode === 'private_confirmed') return 'your own arrangement, as agreed';
  if (r.mode === 'not_required') return 'not needed';
  return 'not arranged yet: we will contact you';
}

async function shiftFacts(tx: Tx, assignmentId: string) {
  const [row] = await tx
    .select({ a: assignments, l: orderLines, o: orders, worker: workers, site: sites, loc: workLocations })
    .from(assignments)
    .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .innerJoin(workers, eq(workers.id, assignments.workerId))
    .leftJoin(sites, eq(sites.id, orderLines.siteId))
    .leftJoin(workLocations, eq(workLocations.id, orderLines.workLocationId))
    .where(eq(assignments.id, assignmentId));
  if (!row) throw notFound('Assignment');
  const reqs = await tx
    .select({ leg: transportRequirements.leg, mode: transportRequirements.mode, note: transportRequirements.arrangementNote, tripRef: trips.reference })
    .from(transportRequirements)
    .leftJoin(trips, eq(trips.id, transportRequirements.tripId))
    .where(eq(transportRequirements.assignmentId, assignmentId));
  const verified = !!row.loc?.verifiedAt;
  const facts: ShiftFacts = {
    reference: row.o.reference,
    lineNo: row.l.lineNo,
    lineVersion: row.l.lineVersion,
    serviceDate: row.l.serviceDate,
    siteName: row.site?.canonicalName ?? 'to be confirmed',
    locationName: row.loc?.name ?? null,
    verifiedPin: verified ? row.loc!.pinText : null,
    accessInstructions: verified ? row.loc!.accessInstructions : null,
    role: row.l.role,
    arrivalAt: row.l.arrivalAt,
    startAt: row.l.startAt,
    endAt: row.l.endAt,
    timezone: row.l.timezone,
    outboundTransport: transportText(reqs.find((r) => r.leg === 'outbound')),
    returnTransport: transportText(reqs.find((r) => r.leg === 'return')),
  };
  return { ...row, facts, siteVerified: verified };
}

async function assertNoOpenConflicts(tx: Tx, orderId: string, lineId: string): Promise<void> {
  const open = await tx
    .select({ id: orderConflicts.id, field: orderConflicts.fieldPath })
    .from(orderConflicts)
    .where(and(eq(orderConflicts.orderId, orderId), eq(orderConflicts.state, 'open'), sql`(${orderConflicts.lineId} is null or ${orderConflicts.lineId} = ${lineId})`));
  if (open.length) {
    throw new DomainError('SOURCE_CONFLICT', `Resolve the conflicting ${open.map((c) => c.field).join(', ')} before sending instructions.`);
  }
}

async function supersedeSiblings(tx: Tx, ctx: ServiceContext, d: { template: string; entityType: string; entityId: string; recipientWorkerId: string | null; recipientDriverId: string | null }) {
  await tx
    .update(messageDrafts)
    .set({ state: 'superseded', endedAt: nowOf(ctx), endReason: 'Replaced by a newer draft', version: sql`${messageDrafts.version} + 1` })
    .where(
      and(
        eq(messageDrafts.template, d.template),
        eq(messageDrafts.entityType, d.entityType),
        eq(messageDrafts.entityId, d.entityId),
        d.recipientWorkerId ? eq(messageDrafts.recipientWorkerId, d.recipientWorkerId) : eq(messageDrafts.recipientDriverId, d.recipientDriverId!),
        inArray(messageDrafts.state, ['draft', 'copied']),
      ),
    );
}

/**
 * Generate a recipient-specific message bound to the current line version or trip revision.
 * Worker messages contain only that worker's details; driver manifests contain passenger
 * names and stops but not phone numbers or other personal data.
 */
export async function generateDraft(ctx: ServiceContext, raw: DraftMessageInput): Promise<{ id: string; content: string; entityRevision: number; contact: string }> {
  const input = draftMessageSchema.parse(raw);
  return command(ctx, { operation: 'message.draft' }, async (tx) => {
    if (input.template === 'driver_manifest') {
      if (!input.tripId) throw new DomainError('VALIDATION_FAILED', 'Choose a journey.');
      return draftManifest(tx, ctx, input.tripId);
    }
    if (!['worker_offer', 'worker_booking', 'amendment', 'cancellation'].includes(input.template)) {
      throw new DomainError('VALIDATION_FAILED', 'This template is not available yet.');
    }
    if (!input.assignmentId) throw new DomainError('VALIDATION_FAILED', 'Choose an assignment.');
    const s = await shiftFacts(tx, input.assignmentId);
    requireCapability(ctx.actor, 'message.draft', s.a.branchId);
    const name = s.worker.displayName.split(' ')[0]!;
    let content: string;
    if (input.template === 'cancellation') {
      if (s.a.state !== 'cancelled') throw new DomainError('INVALID_STATE', 'This assignment is not cancelled.');
      content = cancellation(name, s.facts);
    } else {
      await assertNoOpenConflicts(tx, s.o.id, s.l.id);
      if (s.l.lineState !== 'open') throw new DomainError('INVALID_STATE', 'This shift line is cancelled.');
      if (!s.l.siteId) throw new DomainError('SITE_UNVERIFIED', 'The site is not confirmed yet.');
      if (input.template === 'worker_offer') {
        if (!['proposed', 'offered'].includes(s.a.state)) throw new DomainError('INVALID_STATE', `This assignment is ${s.a.state}.`);
        content = workerOffer(name, s.facts);
      } else if (input.template === 'worker_booking') {
        if (s.a.state !== 'accepted' || s.a.acceptedLineVersion !== s.l.lineVersion) {
          throw new DomainError('STALE_CONFIRMATION', 'The worker has not accepted the current version of this shift.');
        }
        if (!s.siteVerified) throw new DomainError('SITE_UNVERIFIED', 'Verify the site entrance before sending booking details.');
        content = workerBooking(name, s.facts);
      } else {
        const revs = await tx.select().from(orderRevisions).where(eq(orderRevisions.orderId, s.o.id)).orderBy(asc(orderRevisions.revisionNo));
        const changes = revs
          .flatMap((r) => (r.changes as { lineId?: string; field?: string; from?: unknown; to?: unknown }[]) ?? [])
          .filter((c) => c.lineId === s.l.id && c.field && !['requestedCount', 'acceptedCount', 'notes', 'minimumCount'].includes(c.field))
          .slice(-6)
          .map((c) => `${c.field}: ${String(c.from ?? 'none')} → ${String(c.to ?? 'none')}`);
        content = amendment(name, s.facts, changes);
      }
    }
    const contact = await verifiedContact(tx, { workerId: s.a.workerId });
    if (!contact) throw new DomainError('VALIDATION_FAILED', `${s.worker.displayName} has no verified contact number.`);
    await supersedeSiblings(tx, ctx, { template: input.template, entityType: 'order_line', entityId: s.l.id, recipientWorkerId: s.a.workerId, recipientDriverId: null });
    const [row] = await tx
      .insert(messageDrafts)
      .values({
        organisationId: ctx.actor.organisationId,
        branchId: s.a.branchId,
        template: input.template,
        templateVersion: TEMPLATE_VERSIONS[input.template as keyof typeof TEMPLATE_VERSIONS],
        recipientKind: 'worker',
        recipientWorkerId: s.a.workerId,
        contactPointId: contact.id,
        contactValue: contact.value,
        entityType: 'order_line',
        entityId: s.l.id,
        entityRevision: s.l.lineVersion,
        assignmentId: s.a.id,
        content,
        createdBy: actorId(ctx.actor),
      })
      .returning({ id: messageDrafts.id });
    await audit(tx, ctx, { action: 'message.drafted', entityType: 'message_draft', entityId: row!.id, after: { template: input.template, entityRevision: s.l.lineVersion } });
    return { id: row!.id, content, entityRevision: s.l.lineVersion, contact: contact.value };
  });
}

async function draftManifest(tx: Tx, ctx: ServiceContext, tripId: string) {
  const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId));
  if (!trip) throw notFound('Journey');
  requireCapability(ctx.actor, 'message.draft', trip.branchId);
  const [rev] = await tx.select().from(tripRevisions).where(and(eq(tripRevisions.tripId, trip.id), eq(tripRevisions.revisionNo, trip.currentRevision)));
  if (!rev!.driverId) throw new DomainError('VALIDATION_FAILED', 'This journey has no named driver.');
  const [driver] = await tx.select().from(drivers).where(eq(drivers.id, rev!.driverId));
  const [veh] = rev!.vehicleId ? await tx.select().from(vehicles).where(eq(vehicles.id, rev!.vehicleId)) : [];
  const stops = await tx.select({ s: tripStops, loc: workLocations }).from(tripStops).leftJoin(workLocations, eq(workLocations.id, tripStops.workLocationId)).where(eq(tripStops.tripRevisionId, rev!.id)).orderBy(asc(tripStops.seq));
  for (const { s, loc } of stops) {
    if (s.purpose !== 'pickup' && s.workLocationId && !loc?.verifiedAt) throw new DomainError('SITE_UNVERIFIED', `Verify the location for stop ${s.seq} (${s.label}) before sending it to the driver.`);
  }
  const ps = await tx.select({ p: tripPassengers, name: workers.displayName }).from(tripPassengers).innerJoin(workers, eq(workers.id, tripPassengers.workerId)).where(eq(tripPassengers.tripRevisionId, rev!.id));
  let running = rev!.plannedDepartureAt;
  const content = driverManifest(driver!.displayName.split(' ')[0]!, {
    reference: trip.reference,
    revisionNo: rev!.revisionNo,
    serviceDate: trip.serviceDate,
    legType: trip.legType,
    vehicle: veh ? `${veh.identifier}${veh.registration ? ` ${veh.registration}` : ''}` : 'to be confirmed',
    departureAt: rev!.plannedDepartureAt,
    stops: stops.map(({ s, loc }) => {
      if (s.plannedAt) running = s.plannedAt;
      else if (running && s.travelMinutesFromPrevious !== null) running = new Date(running.getTime() + s.travelMinutesFromPrevious * 60_000);
      else if (s.seq > 1) running = null;
      return {
        seq: s.seq,
        purpose: s.purpose,
        label: s.label,
        eta: running,
        pin: loc?.verifiedAt ? loc.pinText : null,
        board: ps.filter(({ p }) => p.boardStopSeq === s.seq).map(({ name }) => name),
        alight: ps.filter(({ p }) => p.alightStopSeq === s.seq).map(({ name }) => name),
      };
    }),
  });
  const contact = await verifiedContact(tx, { driverId: driver!.id });
  if (!contact) throw new DomainError('VALIDATION_FAILED', `${driver!.displayName} has no verified contact number.`);
  await supersedeSiblings(tx, ctx, { template: 'driver_manifest', entityType: 'trip', entityId: trip.id, recipientWorkerId: null, recipientDriverId: driver!.id });
  const [row] = await tx
    .insert(messageDrafts)
    .values({
      organisationId: ctx.actor.organisationId,
      branchId: trip.branchId,
      template: 'driver_manifest',
      templateVersion: TEMPLATE_VERSIONS.driver_manifest,
      recipientKind: 'driver',
      recipientDriverId: driver!.id,
      contactPointId: contact.id,
      contactValue: contact.value,
      entityType: 'trip',
      entityId: trip.id,
      entityRevision: rev!.revisionNo,
      content,
      createdBy: actorId(ctx.actor),
    })
    .returning({ id: messageDrafts.id });
  await audit(tx, ctx, { action: 'message.drafted', entityType: 'message_draft', entityId: row!.id, after: { template: 'driver_manifest', entityRevision: rev!.revisionNo } });
  return { id: row!.id, content, entityRevision: rev!.revisionNo, contact: contact.value };
}

async function currentEntityRevision(tx: Tx, d: DraftRow): Promise<number | null> {
  if (d.entityType === 'order_line') {
    const [l] = await tx.select({ v: orderLines.lineVersion, state: orderLines.lineState }).from(orderLines).where(eq(orderLines.id, d.entityId));
    return l ? l.v : null;
  }
  if (d.entityType === 'trip') {
    const [t] = await tx.select({ v: trips.currentRevision }).from(trips).where(eq(trips.id, d.entityId));
    return t ? t.v : null;
  }
  return null;
}

/** Re-check that a draft still describes the current revision and recipient contact. */
export async function assertDraftCurrent(tx: Tx, d: DraftRow): Promise<void> {
  if (['superseded', 'withdrawn'].includes(d.state)) throw new DomainError('STALE_CONFIRMATION', `This message was ${d.state} and must not be sent.`);
  const current = await currentEntityRevision(tx, d);
  if (current !== d.entityRevision) throw new DomainError('STALE_CONFIRMATION', 'The order or journey changed after this message was drafted. Create a new draft.');
  if (d.contactPointId) {
    const [c] = await tx.select().from(contactPoints).where(eq(contactPoints.id, d.contactPointId));
    if (!c || c.status !== 'active' || c.value !== d.contactValue) throw new DomainError('STALE_CONFIRMATION', "The recipient's contact details changed. Create a new draft.");
  }
  if (d.template !== 'cancellation' && d.assignmentId) {
    const [a] = await tx.select({ state: assignments.state }).from(assignments).where(eq(assignments.id, d.assignmentId));
    if (a && ['cancelled', 'declined', 'superseded'].includes(a.state)) throw new DomainError('STALE_CONFIRMATION', `The assignment is ${a.state}.`);
  }
}

/** The text was copied to the clipboard. Copying is not sending. */
export async function markDraftCopied(ctx: ServiceContext, draftId: string): Promise<{ version: number }> {
  return command(ctx, { operation: 'message.copied' }, async (tx) => {
    const [d] = await tx.select().from(messageDrafts).where(eq(messageDrafts.id, draftId)).for('update');
    if (!d) throw notFound('Message');
    requireCapability(ctx.actor, 'message.draft', d.branchId);
    await assertDraftCurrent(tx, d);
    if (d.state !== 'draft' && d.state !== 'copied') throw new DomainError('INVALID_STATE', `This message is ${d.state}.`);
    await tx.update(messageDrafts).set({ state: 'copied', copiedAt: nowOf(ctx), version: d.version + 1 }).where(eq(messageDrafts.id, d.id));
    return { version: d.version + 1 };
  });
}

/**
 * A person confirms they sent the message themselves (e.g. pasted into WhatsApp). This records
 * a human send, never provider delivery, and never the recipient's agreement.
 */
export async function markManuallySent(ctx: ServiceContext, draftId: string, raw: ManualSentInput, idempotencyKey?: string): Promise<{ state: string; version: number }> {
  const input = manualSentSchema.parse(raw);
  return command(ctx, { operation: 'message.manual_sent', idempotencyKey, input: { draftId, ...input } }, async (tx) => {
    const [d] = await tx.select().from(messageDrafts).where(eq(messageDrafts.id, draftId)).for('update');
    if (!d) throw notFound('Message');
    requireCapability(ctx.actor, 'message.record_sent', d.branchId);
    checkVersion(d.version, input.expectedVersion);
    if (d.state !== 'draft' && d.state !== 'copied') throw new DomainError('INVALID_STATE', `This message is ${d.state}.`);
    await assertDraftCurrent(tx, d);
    await tx
      .update(messageDrafts)
      .set({ state: 'manually_marked_sent', sentAt: new Date(input.sentAt), sentBy: actorId(ctx.actor), sentChannel: input.channel, version: d.version + 1 })
      .where(eq(messageDrafts.id, d.id));
    if (d.template === 'worker_offer' && d.assignmentId) {
      await tx.update(assignments).set({ state: 'offered', updatedAt: nowOf(ctx) }).where(and(eq(assignments.id, d.assignmentId), eq(assignments.state, 'proposed')));
    }
    if ((d.template === 'amendment' || d.template === 'worker_offer') && d.assignmentId) {
      await closeTasksByKey(tx, ctx, `reoffer:${d.assignmentId}`, `Updated offer sent by ${input.channel}`);
    }
    await audit(tx, ctx, { action: 'message.manually_sent', entityType: 'message_draft', entityId: d.id, after: { channel: input.channel, sentAt: input.sentAt, entityRevision: d.entityRevision } });
    await enqueue(tx, ctx, { eventType: 'message.manually_sent', entityType: 'message_draft', entityId: d.id, entityRevision: d.entityRevision });
    return { state: 'manually_marked_sent', version: d.version + 1 };
  });
}

/** The recipient acknowledged this exact message (e.g. replied OK to a cancellation). */
export async function recordMessageAcknowledged(ctx: ServiceContext, draftId: string, note: string): Promise<void> {
  await command(ctx, { operation: 'message.acknowledged' }, async (tx) => {
    const [d] = await tx.select().from(messageDrafts).where(eq(messageDrafts.id, draftId)).for('update');
    if (!d) throw notFound('Message');
    requireCapability(ctx.actor, 'message.record_sent', d.branchId);
    if (!SENT_STATES.includes(d.state) || d.state === 'acknowledged') throw new DomainError('INVALID_STATE', `This message is ${d.state}.`);
    await tx.update(messageDrafts).set({ state: 'acknowledged', acknowledgedAt: nowOf(ctx), version: d.version + 1 }).where(eq(messageDrafts.id, d.id));
    if (d.template === 'cancellation' && d.assignmentId) await closeTasksByKey(tx, ctx, `cancel_ack:${d.assignmentId}`, `Cancellation acknowledged: ${note}`);
    await audit(tx, ctx, { action: 'message.acknowledged', entityType: 'message_draft', entityId: d.id, reason: note });
  });
}

/**
 * Send through an enabled messaging adapter. Queues an outbox event processed after commit by
 * the background worker, which re-checks currency before sending. Refused while the provider is
 * disabled or manual: in that case the person sends it themselves and records it.
 */
export async function queueProviderSend(ctx: ServiceContext, draftId: string, expectedVersion: number): Promise<{ version: number }> {
  return command(ctx, { operation: 'message.queue_send' }, async (tx) => {
    const [d] = await tx.select().from(messageDrafts).where(eq(messageDrafts.id, draftId)).for('update');
    if (!d) throw notFound('Message');
    requireCapability(ctx.actor, 'message.record_sent', d.branchId);
    checkVersion(d.version, expectedVersion);
    const [setting] = await tx.select().from(integrationSettings).where(eq(integrationSettings.provider, 'whatsapp'));
    if (!setting || !['connected', 'sandbox'].includes(setting.status)) {
      throw new DomainError('INTEGRATION_DISABLED', 'Automatic sending is not enabled. Copy the message, send it yourself, then record it as sent.');
    }
    if (d.state !== 'draft' && d.state !== 'copied') throw new DomainError('INVALID_STATE', `This message is ${d.state}.`);
    await assertDraftCurrent(tx, d);
    await tx.update(messageDrafts).set({ state: 'queued', version: d.version + 1 }).where(eq(messageDrafts.id, d.id));
    await enqueue(tx, ctx, { eventType: 'message.dispatch', entityType: 'message_draft', entityId: d.id, entityRevision: d.entityRevision, payload: { provider: 'whatsapp' } });
    await audit(tx, ctx, { action: 'message.queued', entityType: 'message_draft', entityId: d.id });
    return { version: d.version + 1 };
  });
}
