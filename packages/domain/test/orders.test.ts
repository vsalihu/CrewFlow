import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DomainError } from '@cds/contracts';
import { assignments, orderLines, orderRevisions, orders, tasks } from '@cds/db';
import {
  amendOrder,
  createOrder,
  decideAcceptance,
  previewAmendment,
  proposeAssignments,
  raiseConflict,
  read,
  recordWorkerResponse,
  resolveConflict,
} from '@cds/domain';
import { acceptedOrder, line, source, useWorld } from './support';

const world = useWorld();

async function expectDomainError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  return err as DomainError;
}

describe('order intake', () => {
  it('AT01/AT05: one client message with several roles, sites and start times becomes separate shift lines', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const s = await source(ctx, seed, 'Need 8 pickers Haddon, 6 graders packhouse (4 at 7, 6 at 11:30?) and 4 harvesters at Gault');
    const o = await createOrder(ctx, {
      branchId: seed.branches.north,
      clientId: seed.clients.growers,
      sourceMessageIds: [s.id],
      lines: [
        line(seed, { role: 'Picker', requestedCount: 8 }),
        line(seed, { role: 'Grader', requestedCount: 4, startLocal: '07:00', arrivalLocal: '06:50' }),
        line(seed, { role: 'Grader', requestedCount: 6, startLocal: '11:30', arrivalLocal: '11:20', endLocal: '19:30' }),
        line(seed, { role: 'Harvester', requestedCount: 4, siteId: seed.sites.field, workLocationId: seed.locations.fieldEntrance }),
      ],
    });
    const ls = await read(ctx, (tx) => tx.select().from(orderLines).where(eq(orderLines.orderId, o.id)));
    expect(ls).toHaveLength(4);
    expect(ls.map((l) => l.requestedCount).sort()).toEqual([4, 4, 6, 8]);
    // Nothing is accepted just because it was received.
    expect(ls.every((l) => l.acceptedCount === null)).toBe(true);
    const [order] = await read(ctx, (tx) => tx.select().from(orders).where(eq(orders.id, o.id)));
    expect(order!.requestState).toBe('received');
    const revs = await read(ctx, (tx) => tx.select().from(orderRevisions).where(eq(orderRevisions.orderId, o.id)));
    expect(revs).toHaveLength(1);
  });

  it('saves an incomplete request without inventing a site or a start time', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const s = await source(ctx, seed, 'Can you send some people tomorrow?');
    const o = await createOrder(ctx, {
      branchId: seed.branches.north,
      clientId: seed.clients.growers,
      sourceMessageIds: [s.id],
      requestState: 'needs_clarification',
      lines: [{ serviceDate: '2026-10-10', requestedCount: 3 }],
    });
    const [l] = await read(ctx, (tx) => tx.select().from(orderLines).where(eq(orderLines.orderId, o.id)));
    expect(l!.siteId).toBeNull();
    expect(l!.startAt).toBeNull();
    expect(l!.endUnknown).toBe(true);
    const t = await read(ctx, (tx) => tx.select().from(tasks).where(and(eq(tasks.entityId, l!.id), eq(tasks.type, 'clarify_site'))));
    expect(t).toHaveLength(1);
  });

  it('AT29: a time that happens twice when clocks go back is rejected for clarification, overnight needs an explicit end day', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const s = await source(ctx, seed, 'Night shift');
    await expectDomainError(
      createOrder(ctx, { branchId: seed.branches.north, clientId: seed.clients.coldStore, sourceMessageIds: [s.id], lines: [line(seed, { siteId: seed.sites.coldStore, workLocationId: null, serviceDate: '2026-10-25', arrivalLocal: null, startLocal: '01:30', endLocal: '09:00' })] }),
      'VALIDATION_FAILED',
    );
    await expectDomainError(
      createOrder(ctx, { branchId: seed.branches.north, clientId: seed.clients.coldStore, sourceMessageIds: [s.id], lines: [line(seed, { siteId: seed.sites.coldStore, workLocationId: null, arrivalLocal: null, startLocal: '22:00', endLocal: '06:00' })] }),
      'VALIDATION_FAILED',
    );
    const ok = await createOrder(ctx, {
      branchId: seed.branches.north,
      clientId: seed.clients.coldStore,
      sourceMessageIds: [s.id],
      lines: [line(seed, { siteId: seed.sites.coldStore, workLocationId: null, serviceDate: '2026-10-24', arrivalLocal: null, startLocal: '22:00', endLocal: '06:00', endDayOffset: 1 })],
    });
    const [l] = await read(ctx, (tx) => tx.select().from(orderLines).where(eq(orderLines.orderId, ok.id)));
    // 22:00 BST to 06:00 GMT across the DST change is 9 hours elapsed, not 8.
    expect((l!.endAt!.getTime() - l!.startAt!.getTime()) / 3_600_000).toBe(9);
  });

  it('AT53: an urgent early-morning request with nobody on duty is saved with an unowned coverage alert', async () => {
    const ctx = await world.as('coordinator');
    const { seed, clock } = world;
    clock.set('2026-10-10T04:40:00Z'); // 05:40 local, work starts 07:00
    const s = await source(ctx, seed, 'Need 3 more at 7 today please', '2026-10-10T05:38:00+01:00');
    const o = await createOrder(ctx, { branchId: seed.branches.north, clientId: seed.clients.growers, sourceMessageIds: [s.id], lines: [line(seed, { requestedCount: 3 })] });
    expect(o.urgency).toBe('urgent');
    const [t] = await read(ctx, (tx) => tx.select().from(tasks).where(and(eq(tasks.entityId, o.id), eq(tasks.type, 'late_order_review'))));
    expect(t!.ownerMembershipId).toBeNull();
    expect(t!.coverageAlert).toBe(true);
    expect(t!.priority).toBe('urgent');
    const [order] = await read(ctx, (tx) => tx.select().from(orders).where(eq(orders.id, o.id)));
    expect(order!.requestState).toBe('received'); // no automatic fulfilment promise
    clock.set('2026-10-09T17:00:00Z');
  });
});

describe('conflicts and amendments', () => {
  it('AT02: client says 06:30, internal booking says 07:00: a visible conflict, neither value silently wins', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 10 })]);
    const s2 = await source(ctx, seed, 'Can they be there for 6:30 please');
    const c = await raiseConflict(ctx, o.id, {
      lineId: o.lines[0]!.id,
      fieldPath: 'startLocal',
      observations: [
        { value: '07:00', note: 'Internal booking' },
        { value: '06:30', sourceMessageId: s2.id },
      ],
    });
    const [l] = await read(ctx, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, o.lines[0]!.id)));
    expect(l!.startLocal).toBe('07:00:00'); // unchanged until a person decides
    await resolveConflict(ctx, c.id, { resolvedValue: '06:30', note: 'Called Gwen; she confirmed 06:30 arrival' });
    const open = await read(ctx, (tx) => tx.select().from(tasks).where(and(eq(tasks.entityId, c.id), eq(tasks.state, 'open'))));
    expect(open).toHaveLength(0);
  });

  it('AT03: count increases from four to ten: new revision, six more vacancies, existing assignments kept', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 4 })]);
    const l = o.lines[0]!;
    const { assignmentIds } = await proposeAssignments(ctx, l.id, { workers: [{ workerId: seed.workers.mira }, { workerId: seed.workers.teodor }] });
    await recordWorkerResponse(ctx, assignmentIds[0]!, { lineVersion: 1, response: 'accepted', channel: 'phone', respondedAt: '2026-10-09T18:05:00+01:00' });
    const s = await source(ctx, seed, 'Actually need 10 tomorrow');
    const input = { expectedVersion: o.version, sourceMessageIds: [s.id], reason: 'Client increased graders', lineChanges: [{ lineId: l.id, requestedCount: 10 }] };
    const preview = await previewAmendment(ctx, o.id, input);
    expect(preview.reconfirmations).toHaveLength(0); // count change is not material for workers
    const res = await amendOrder(ctx, o.id, { ...input, acknowledgeImpactToken: preview.token });
    expect(res.revision).toBeGreaterThan(1);
    const [after] = await read(ctx, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, l.id)));
    expect(after!.requestedCount).toBe(10);
    expect(after!.acceptedCount).toBe(4); // agency acceptance is a separate decision
    expect(after!.requestedCount - after!.acceptedCount!).toBe(6);
    const [a] = await read(ctx, (tx) => tx.select().from(assignments).where(eq(assignments.id, assignmentIds[0]!)));
    expect(a!.state).toBe('accepted');
  });

  it('a time change makes confirmed workers reconfirm and rejects a stale preview token', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 2 })]);
    const l = o.lines[0]!;
    const { assignmentIds } = await proposeAssignments(ctx, l.id, { workers: [{ workerId: seed.workers.ralitsa }] });
    await recordWorkerResponse(ctx, assignmentIds[0]!, { lineVersion: 1, response: 'accepted', channel: 'phone', respondedAt: '2026-10-09T18:05:00+01:00' });
    const s = await source(ctx, seed, 'Start at 8 instead');
    const input = { expectedVersion: o.version, sourceMessageIds: [s.id], reason: 'Later start', lineChanges: [{ lineId: l.id, arrivalLocal: '07:50', startLocal: '08:00' }] };
    const preview = await previewAmendment(ctx, o.id, input);
    expect(preview.reconfirmations.map((r) => r.assignmentId)).toEqual(assignmentIds);
    // A token for different input is refused.
    await expectDomainError(amendOrder(ctx, o.id, { ...input, reason: 'Something else', acknowledgeImpactToken: preview.token }), 'STALE_PREVIEW');
    await amendOrder(ctx, o.id, { ...input, acknowledgeImpactToken: preview.token });
    const [a] = await read(ctx, (tx) => tx.select().from(assignments).where(eq(assignments.id, assignmentIds[0]!)));
    expect(a!.state).toBe('reconfirmation_required');
    const [l2] = await read(ctx, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, l.id)));
    expect(l2!.lineVersion).toBe(2);
    // Concurrent edit protection: the old version is now rejected.
    await expectDomainError(previewAmendment(ctx, o.id, { ...input, expectedVersion: o.version }), 'VERSION_CONFLICT');
  });

  it('AT17: a worker accepting revision 1 after the shift moved to revision 2 is kept as evidence but does not confirm', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 2 })]);
    const l = o.lines[0]!;
    const { assignmentIds } = await proposeAssignments(ctx, l.id, { workers: [{ workerId: seed.workers.bozhidar }] });
    const s = await source(ctx, seed, 'Move to the field');
    const input = { expectedVersion: o.version, sourceMessageIds: [s.id], reason: 'Different site', lineChanges: [{ lineId: l.id, siteId: seed.sites.field, workLocationId: seed.locations.fieldEntrance }] };
    const preview = await previewAmendment(ctx, o.id, input);
    expect(preview.staleOffers).toHaveLength(1);
    await amendOrder(ctx, o.id, { ...input, acknowledgeImpactToken: preview.token });
    const r = await recordWorkerResponse(ctx, assignmentIds[0]!, { lineVersion: 1, response: 'accepted', channel: 'whatsapp_manual', respondedAt: '2026-10-09T19:00:00+01:00' });
    expect(r.outcome).toBe('stale');
    const [a] = await read(ctx, (tx) => tx.select().from(assignments).where(eq(assignments.id, assignmentIds[0]!)));
    expect(a!.state).toBe('proposed');
    const r2 = await recordWorkerResponse(ctx, assignmentIds[0]!, { lineVersion: 2, response: 'accepted', channel: 'phone', respondedAt: '2026-10-09T19:05:00+01:00' });
    expect(r2.outcome).toBe('applied');
  });
});

describe('staffing', () => {
  it('AT04/AT20: duplicates are rejected and assignments cannot exceed the accepted count', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 3, startLocal: '12:00', arrivalLocal: '11:50', endLocal: '16:00' })]);
    const l = o.lines[0]!;
    await expectDomainError(proposeAssignments(ctx, l.id, { workers: [{ workerId: seed.workers.nevena }, { workerId: seed.workers.nevena }] }), 'VALIDATION_FAILED');
    await proposeAssignments(ctx, l.id, { workers: [{ workerId: seed.workers.nevena }, { workerId: seed.workers.desislava }] });
    await expectDomainError(proposeAssignments(ctx, l.id, { workers: [{ workerId: seed.workers.nevena }] }), 'VALIDATION_FAILED');
    await expectDomainError(proposeAssignments(ctx, l.id, { workers: [{ workerId: seed.workers.ognyan }, { workerId: seed.workers.radka }] }), 'CAPACITY_EXCEEDED');
  });

  it('cannot assign before the agency has accepted a quantity', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const s = await source(ctx, seed, 'two graders');
    const o = await createOrder(ctx, { branchId: seed.branches.north, clientId: seed.clients.growers, sourceMessageIds: [s.id], lines: [line(seed, { requestedCount: 2, serviceDate: '2026-10-12' })] });
    const [l] = await read(ctx, (tx) => tx.select().from(orderLines).where(eq(orderLines.orderId, o.id)));
    await expectDomainError(proposeAssignments(ctx, l!.id, { workers: [{ workerId: seed.workers.mira }] }), 'INVALID_STATE');
    await expectDomainError(decideAcceptance(ctx, o.id, { expectedVersion: 1, decisions: [{ lineId: l!.id, acceptedCount: 3 }] }), 'VALIDATION_FAILED');
    const partial = await decideAcceptance(ctx, o.id, { expectedVersion: 1, decisions: [{ lineId: l!.id, acceptedCount: 1 }], note: 'Only one grader free' });
    expect(partial.requestState).toBe('partially_accepted');
  });

  it('AT21: a worker who must leave at 18:00 is excluded from a shift ending 20:00, with the reason', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 2, serviceDate: '2026-10-13', endLocal: '20:00' })]);
    const err = await expectDomainError(proposeAssignments(ctx, o.lines[0]!.id, { workers: [{ workerId: seed.workers.siyana }] }), 'WORKER_UNAVAILABLE');
    expect(err.violations[0]!.message).toContain('18:00');
  });

  it('AT25: pending registration or expired eligibility blocks proposal; no conclusion is inferred', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 2, serviceDate: '2026-10-14' })]);
    const e1 = await expectDomainError(proposeAssignments(ctx, o.lines[0]!.id, { workers: [{ workerId: seed.workers.yordan }] }), 'READINESS_BLOCKED');
    expect(e1.violations[0]!.message).toContain('Registration complete (pending)');
    const e2 = await expectDomainError(proposeAssignments(ctx, o.lines[0]!.id, { workers: [{ workerId: seed.workers.emil }] }), 'READINESS_BLOCKED');
    expect(e2.violations[0]!.message).toContain('expired');
  });

  it('AT22: two coordinators propose the same worker for overlapping shifts at once: exactly one commits', async () => {
    const a = await world.as('coordinator');
    const b = await world.as('coordinator2');
    const { seed } = world;
    const o1 = await acceptedOrder(a, seed, [line(seed, { requestedCount: 1, serviceDate: '2026-10-15' })]);
    const o2 = await acceptedOrder(b, seed, [line(seed, { requestedCount: 1, serviceDate: '2026-10-15', role: 'Packer', startLocal: '09:00', arrivalLocal: '08:50' })]);
    const results = await Promise.allSettled([
      proposeAssignments(a, o1.lines[0]!.id, { workers: [{ workerId: seed.workers.kaloyan }] }),
      proposeAssignments(b, o2.lines[0]!.id, { workers: [{ workerId: seed.workers.kaloyan }] }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0]!.reason as DomainError).code).toBe('RESOURCE_CONFLICT');
  });

  it('AT19: when the client declines a replacement, replacement tasks stop for that line', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const { recordReplacementDeclined } = await import('@cds/domain');
    const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: 2, serviceDate: '2026-10-16' })]);
    const l = o.lines[0]!;
    const { assignmentIds } = await proposeAssignments(ctx, l.id, { workers: [{ workerId: seed.workers.mira }, { workerId: seed.workers.teodor }] });
    await recordWorkerResponse(ctx, assignmentIds[0]!, { lineVersion: 1, response: 'declined', channel: 'phone', respondedAt: '2026-10-09T18:30:00+01:00' });
    const open = () => read(ctx, (tx) => tx.select().from(tasks).where(and(eq(tasks.entityId, l.id), eq(tasks.type, 'find_replacement'), eq(tasks.state, 'open'))));
    expect(await open()).toHaveLength(1);
    await recordReplacementDeclined(ctx, l.id, 'Supervisor said they will manage with one');
    expect(await open()).toHaveLength(0);
    await recordWorkerResponse(ctx, assignmentIds[1]!, { lineVersion: 1, response: 'declined', channel: 'phone', respondedAt: '2026-10-09T18:40:00+01:00' });
    expect(await open()).toHaveLength(0);
  });
});
