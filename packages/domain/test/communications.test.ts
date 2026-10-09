import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError } from '@cds/contracts';
import { integrationSettings, messageDrafts, outboxEvents, tasks } from '@cds/db';
import {
  amendOrder,
  cancelOrder,
  createTrip,
  generateDraft,
  markDraftCopied,
  markManuallySent,
  previewAmendment,
  processOutbox,
  proposeAssignments,
  proposeTripToDriver,
  queueProviderSend,
  raiseConflict,
  read,
  recordMessageAcknowledged,
  recordTripAcceptance,
  recordWorkerResponse,
  releaseStuckOutbox,
} from '@cds/domain';
import { SandboxMessagingAdapter } from '@cds/integrations';
import { acceptedOrder, line, source, useWorld } from './support';

const world = useWorld();

async function enableSandbox() {
  await world.tdb.ownerDb.update(integrationSettings).set({ status: 'sandbox' }).where(eq(integrationSettings.provider, 'whatsapp'));
}

describe('message drafts', () => {
  it('worker messages are revision-bound, show the full date and weekday, and never include other workers', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 2 })]);
    const l = o.lines[0]!;
    const { assignmentIds } = await proposeAssignments(ctx, l.id, { workers: [{ workerId: seed.workers.mira }, { workerId: seed.workers.teodor }] });
    const offer = await generateDraft(ctx, { template: 'worker_offer', assignmentId: assignmentIds[0]! });
    expect(offer.content).toContain('Saturday 10 October 2026');
    expect(offer.content).toContain('Arrive by: 06:50');
    expect(offer.content).toContain('Work starts: 07:00');
    expect(offer.content).toContain(`${o.reference}-1 v1`);
    expect(offer.content).not.toContain('Teodor');
    // Booking details cannot be generated until the worker accepted the current version.
    await expect(generateDraft(ctx, { template: 'worker_booking', assignmentId: assignmentIds[0]! })).rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
    const c = await markDraftCopied(ctx, offer.id);
    const sent = await markManuallySent(ctx, offer.id, { expectedVersion: c.version, channel: 'whatsapp_manual', sentAt: '2026-10-09T18:10:00+01:00' });
    expect(sent.state).toBe('manually_marked_sent'); // a human send, not provider delivery
    await recordWorkerResponse(ctx, assignmentIds[0]!, { lineVersion: 1, response: 'accepted', channel: 'whatsapp_manual', respondedAt: '2026-10-09T18:20:00+01:00' });
    const booking = await generateDraft(ctx, { template: 'worker_booking', assignmentId: assignmentIds[0]! });
    expect(booking.content).toContain('Transport there: not arranged yet (we will contact you)');
    expect(booking.content).toContain('what3words ///example.packhouse.gate');
  });

  it('no instructions while a source conflict is open, and no unverified entrance is sent', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 1, serviceDate: '2026-10-11' })]);
    const { assignmentIds } = await proposeAssignments(ctx, o.lines[0]!.id, { workers: [{ workerId: seed.workers.ralitsa }] });
    await raiseConflict(ctx, o.id, { lineId: o.lines[0]!.id, fieldPath: 'startLocal', observations: [{ value: '07:00' }, { value: '06:30' }] });
    await expect(generateDraft(ctx, { template: 'worker_offer', assignmentId: assignmentIds[0]! })).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });

    const f = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 1, serviceDate: '2026-10-11', siteId: seed.sites.field, workLocationId: seed.locations.fieldEntrance, startLocal: '13:00', arrivalLocal: '12:50', endLocal: '18:00' })]);
    const r = await proposeAssignments(ctx, f.lines[0]!.id, { workers: [{ workerId: seed.workers.bozhidar }] });
    const offer = await generateDraft(ctx, { template: 'worker_offer', assignmentId: r.assignmentIds[0]! });
    expect(offer.content).not.toContain('Location:');
    await recordWorkerResponse(ctx, r.assignmentIds[0]!, { lineVersion: 1, response: 'accepted', channel: 'phone', respondedAt: '2026-10-10T09:00:00+01:00' });
    await expect(generateDraft(ctx, { template: 'worker_booking', assignmentId: r.assignmentIds[0]! })).rejects.toMatchObject({ code: 'SITE_UNVERIFIED' });
  });

  it('an amendment supersedes unsent drafts and a stale draft cannot be recorded as sent', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 1, serviceDate: '2026-10-12' })]);
    const l = o.lines[0]!;
    const { assignmentIds } = await proposeAssignments(ctx, l.id, { workers: [{ workerId: seed.workers.nevena }] });
    const offer = await generateDraft(ctx, { template: 'worker_offer', assignmentId: assignmentIds[0]! });
    const s = await source(ctx, seed, 'start 8 not 7');
    const input = { expectedVersion: o.version, sourceMessageIds: [s.id], reason: 'Later start', lineChanges: [{ lineId: l.id, arrivalLocal: '07:50', startLocal: '08:00' }] };
    const p = await previewAmendment(ctx, o.id, input);
    expect(p.pendingMessagesToSupersede).toBe(1);
    await amendOrder(ctx, o.id, { ...input, acknowledgeImpactToken: p.token });
    const [d] = await read(ctx, (tx) => tx.select().from(messageDrafts).where(eq(messageDrafts.id, offer.id)));
    expect(d!.state).toBe('superseded');
    await expect(markManuallySent(ctx, offer.id, { expectedVersion: d!.version, channel: 'whatsapp_manual', sentAt: '2026-10-09T19:00:00+01:00' })).rejects.toBeInstanceOf(DomainError);
  });

  it('AT15: a 06:29 cancellation withdraws unsent instructions and asks for acknowledgement from everyone already told', async () => {
    const ctx = await world.as('coordinator');
    const { seed, clock } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 2, serviceDate: '2026-10-13' })]);
    const { assignmentIds } = await proposeAssignments(ctx, o.lines[0]!.id, { workers: [{ workerId: seed.workers.desislava }, { workerId: seed.workers.ognyan }] });
    const told = await generateDraft(ctx, { template: 'worker_offer', assignmentId: assignmentIds[0]! });
    await markManuallySent(ctx, told.id, { expectedVersion: 1, channel: 'whatsapp_manual', sentAt: '2026-10-12T18:00:00+01:00' });
    const notYet = await generateDraft(ctx, { template: 'worker_offer', assignmentId: assignmentIds[1]! });
    clock.set('2026-10-13T05:29:00Z');
    const s = await source(ctx, seed, 'Sorry no work today, rain', '2026-10-13T06:29:00+01:00');
    const res = await cancelOrder(ctx, o.id, { expectedVersion: o.version, scope: 'order', reason: 'Client cancelled: rain', sourceMessageIds: [s.id] });
    expect(res.cancelledAssignments).toBe(2);
    expect(res.acknowledgementTasks).toBe(1);
    const [withdrawn] = await read(ctx, (tx) => tx.select().from(messageDrafts).where(eq(messageDrafts.id, notYet.id)));
    expect(withdrawn!.state).toBe('withdrawn');
    const ack = await read(ctx, (tx) => tx.select().from(tasks).where(and(eq(tasks.entityId, assignmentIds[0]!), eq(tasks.type, 'cancellation_ack'), eq(tasks.state, 'open'))));
    expect(ack[0]!.priority).toBe('urgent');
    const cancelMsg = await generateDraft(ctx, { template: 'cancellation', assignmentId: assignmentIds[0]! });
    expect(cancelMsg.content).toContain('CANCELLED');
    await markManuallySent(ctx, cancelMsg.id, { expectedVersion: 1, channel: 'phone', sentAt: '2026-10-13T06:35:00+01:00' });
    await recordMessageAcknowledged(ctx, cancelMsg.id, 'She replied OK');
    const still = await read(ctx, (tx) => tx.select().from(tasks).where(and(eq(tasks.entityId, assignmentIds[0]!), eq(tasks.type, 'cancellation_ack'), eq(tasks.state, 'open'))));
    expect(still).toHaveLength(0);
    clock.set('2026-10-09T17:00:00Z');
  });

  it('driver manifests list passengers and stops but no phone numbers', async () => {
    const ctx = await world.as('dispatcher');
    const coord = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(coord, seed, [line(seed, { requestedCount: 1, serviceDate: '2026-10-14' })]);
    const { assignmentIds } = await proposeAssignments(coord, o.lines[0]!.id, { workers: [{ workerId: seed.workers.radka }] });
    await recordWorkerResponse(coord, assignmentIds[0]!, { lineVersion: 1, response: 'accepted', channel: 'phone', respondedAt: '2026-10-13T18:00:00+01:00' });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: '2026-10-14',
      legType: 'outbound',
      driverId: seed.drivers.mo,
      vehicleId: seed.vehicles.car,
      plannedDepartureAt: '2026-10-14T06:00:00+01:00',
      estimatedEndAt: '2026-10-14T06:40:00+01:00',
      stops: [
        { purpose: 'pickup', label: 'Town square' },
        { purpose: 'dropoff', label: 'Packhouse gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 30 },
      ],
      passengers: [{ workerId: seed.workers.radka, assignmentId: assignmentIds[0]!, boardStopSeq: 1, alightStopSeq: 2 }],
    });
    await proposeTripToDriver(ctx, t.id, t.version);
    await recordTripAcceptance(ctx, t.id, { revisionNo: 1, decision: 'accepted', method: 'phone', decidedAt: '2026-10-13T19:00:00+01:00' });
    const m = await generateDraft(ctx, { template: 'driver_manifest', tripId: t.id });
    expect(m.content).toContain('Collect: Radka Bozova');
    expect(m.content).toContain('06:30 Drop off: Packhouse gate');
    expect(m.content).not.toMatch(/07700/);
  });
});

describe('outbox', () => {
  it('AT46: a queued message whose order was cancelled is not sent when the worker wakes up', async () => {
    await enableSandbox();
    const ctx = await world.as('coordinator');
    const { seed, tdb } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 1, serviceDate: '2026-10-15' })]);
    const { assignmentIds } = await proposeAssignments(ctx, o.lines[0]!.id, { workers: [{ workerId: seed.workers.kaloyan }] });
    const d = await generateDraft(ctx, { template: 'worker_offer', assignmentId: assignmentIds[0]! });
    await queueProviderSend(ctx, d.id, 1);
    await cancelOrder(ctx, o.id, { expectedVersion: o.version, scope: 'order', reason: 'Client cancelled' });
    const adapter = new SandboxMessagingAdapter('accept');
    const results = await processOutbox(tdb.appDb, { messaging: adapter }, { limit: 100 });
    expect(results.find((r) => r.eventType === 'message.dispatch')!.outcome).toBe('skipped_stale');
    expect(adapter.sent).toHaveLength(0);
  });

  it('AT45: a provider timeout leaves delivery unknown and is never blindly resent', async () => {
    await enableSandbox();
    const ctx = await world.as('coordinator');
    const { seed, tdb } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 1, serviceDate: '2026-10-16' })]);
    const { assignmentIds } = await proposeAssignments(ctx, o.lines[0]!.id, { workers: [{ workerId: seed.workers.lazar }] });
    const d = await generateDraft(ctx, { template: 'worker_offer', assignmentId: assignmentIds[0]! });
    await queueProviderSend(ctx, d.id, 1);
    const adapter = new SandboxMessagingAdapter('timeout');
    await processOutbox(tdb.appDb, { messaging: adapter }, { limit: 100 });
    const [after] = await read(ctx, (tx) => tx.select().from(messageDrafts).where(eq(messageDrafts.id, d.id)));
    expect(after!.state).toBe('delivery_unknown');
    const reconcile = await read(ctx, (tx) => tx.select().from(tasks).where(and(eq(tasks.entityId, d.id), eq(tasks.type, 'reconcile_delivery'))));
    expect(reconcile).toHaveLength(1);
    // Re-queueing is refused because the draft is no longer a draft.
    await expect(queueProviderSend(ctx, d.id, after!.version)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(adapter.sent).toHaveLength(1);
  });

  it('AT47: an event abandoned by a crashed worker is released and processed once', async () => {
    await enableSandbox();
    const ctx = await world.as('coordinator');
    const { seed, tdb } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 1, serviceDate: '2026-10-17' })]);
    const { assignmentIds } = await proposeAssignments(ctx, o.lines[0]!.id, { workers: [{ workerId: seed.workers.teodor }] });
    const d = await generateDraft(ctx, { template: 'worker_offer', assignmentId: assignmentIds[0]! });
    await queueProviderSend(ctx, d.id, 1);
    // Simulate a crash: claim the events, then never finish them.
    await tdb.appDb.execute(sql`select * from app.claim_outbox(100)`);
    await tdb.ownerDb.update(outboxEvents).set({ nextAttemptAt: new Date(Date.now() - 30 * 60_000) }).where(eq(outboxEvents.state, 'processing'));
    expect(await releaseStuckOutbox(tdb.appDb, 10)).toBeGreaterThan(0);
    const adapter = new SandboxMessagingAdapter('accept');
    const results = await processOutbox(tdb.appDb, { messaging: adapter }, { limit: 100 });
    expect(results.find((r) => r.eventType === 'message.dispatch')!.outcome).toBe('done');
    expect(adapter.sent).toHaveLength(1);
    const [after] = await read(ctx, (tx) => tx.select().from(messageDrafts).where(eq(messageDrafts.id, d.id)));
    expect(after!.state).toBe('provider_accepted');
    expect(await processOutbox(tdb.appDb, { messaging: adapter }, { limit: 100 })).toHaveLength(0);
  });
});
