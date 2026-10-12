// Regression tests for journey revision safety, transport status after passenger removal,
// site entrance validation and conflict checks before messages.

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { LineInput } from '@cds/contracts';
import { messageDrafts, orderLines, tasks, transportRequirements, workLocations } from '@cds/db';
import {
  amendOrder,
  addTripPassenger,
  createOrder,
  createTrip,
  generateDraft,
  getOrderDetail,
  markManuallySent,
  previewAmendment,
  proposeAssignments,
  proposeTripToDriver,
  publishTrip,
  raiseConflict,
  read,
  recordTripAcceptance,
  recordWorkerResponse,
  reviseTrip,
  setTripProgress,
  validateTrip,
  type ServiceContext,
} from '@cds/domain';
import type { Seed } from '@cds/test-fixtures';
import { acceptedOrder, line, source, useWorld } from './support';

const world = useWorld();

async function crew(ctx: ServiceContext, seed: Seed, keys: (keyof Seed['workers'])[], overrides: Partial<LineInput> = {}) {
  const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: keys.length, ...overrides })]);
  const l = o.lines[0]!;
  const { assignmentIds } = await proposeAssignments(ctx, l.id, { workers: keys.map((k) => ({ workerId: seed.workers[k] })) });
  for (const id of assignmentIds) {
    await recordWorkerResponse(ctx, id, { lineVersion: l.lineVersion, response: 'accepted', channel: 'phone', respondedAt: '2026-10-09T18:00:00+01:00' });
  }
  return { order: o, line: l, ids: Object.fromEntries(keys.map((k, i) => [k, assignmentIds[i]!])) as Record<string, string> };
}

function outbound(seed: Seed, date: string, passengers: { workerId: string; assignmentId: string }[], dropLocation = seed.locations.packhouseGate) {
  return {
    driverId: seed.drivers.mo,
    vehicleId: seed.vehicles.minibus,
    plannedDepartureAt: `${date}T06:00:00+01:00`,
    estimatedEndAt: `${date}T06:40:00+01:00`,
    stops: [
      { purpose: 'pickup' as const, label: 'Town square' },
      { purpose: 'dropoff' as const, label: 'Drop', workLocationId: dropLocation, travelMinutesFromPrevious: 30 },
    ],
    passengers: passengers.map((p) => ({ ...p, boardStopSeq: 1, alightStopSeq: 2 })),
  };
}

async function publish(ctx: ServiceContext, tripId: string, version: number, revisionNo = 1) {
  const p = version === 1 ? await proposeTripToDriver(ctx, tripId, version) : { version };
  const a = await recordTripAcceptance(ctx, tripId, { revisionNo, decision: 'accepted', method: 'phone', decidedAt: '2026-10-09T19:00:00+01:00' });
  expect(a.outcome).toBe('applied');
  return publishTrip(ctx, tripId, a.version ?? p.version);
}

describe('journey revision safety', () => {
  it('a journey already travelling cannot be revised without recording a disruption', async () => {
    const coord = await world.as('coordinator');
    const ctx = await world.as('dispatcher');
    const { seed } = world;
    const d = '2026-10-20';
    const c = await crew(coord, seed, ['mira'], { serviceDate: d });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      ...outbound(seed, d, [{ workerId: seed.workers.mira, assignmentId: c.ids.mira! }]),
    });
    const pub = await publish(ctx, t.id, t.version);
    const dep = await setTripProgress(ctx, t.id, 'departed', pub.version);
    await expect(reviseTrip(ctx, t.id, { expectedVersion: dep.version, reason: 'late change', ...outbound(seed, d, []) })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('a removed passenger no longer looks covered by the journey, and gets a re-plan task', async () => {
    const coord = await world.as('coordinator');
    const ctx = await world.as('dispatcher');
    const { seed } = world;
    const d = '2026-10-21';
    const c = await crew(coord, seed, ['teodor', 'ralitsa'], { serviceDate: d });
    const both = [
      { workerId: seed.workers.teodor, assignmentId: c.ids.teodor! },
      { workerId: seed.workers.ralitsa, assignmentId: c.ids.ralitsa! },
    ];
    const t = await createTrip(ctx, { branchId: seed.branches.north, serviceDate: d, legType: 'outbound', ...outbound(seed, d, both) });
    const pub = await publish(ctx, t.id, t.version);
    const r = await reviseTrip(ctx, t.id, { expectedVersion: pub.version, reason: 'Ralitsa travels with family', ...outbound(seed, d, [both[0]!]) });
    const leg = async (id: string) =>
      (
        await read(ctx, (tx) =>
          tx
            .select()
            .from(transportRequirements)
            .where(and(eq(transportRequirements.assignmentId, id), eq(transportRequirements.leg, 'outbound'))),
        )
      )[0]!;
    expect((await leg(c.ids.ralitsa!)).mode).toBe('unresolved');
    expect((await leg(c.ids.ralitsa!)).tripId).toBeNull();
    expect((await leg(c.ids.teodor!)).mode).toBe('agency_trip');
    const replan = await read(ctx, (tx) =>
      tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.entityId, c.ids.ralitsa!), eq(tasks.type, 'replan_transport'))),
    );
    expect(replan).toHaveLength(1);
    // Re-publishing the smaller manifest does not cover the removed person again.
    await publish(ctx, t.id, r.version, r.revisionNo);
    expect((await leg(c.ids.ralitsa!)).mode).toBe('unresolved');
    const status = (await getOrderDetail(coord, c.order.id)).lines[0]!.status;
    expect(status.transportUnresolvedLegs).toBeGreaterThan(0);
  });

  it('adding a passenger withdraws unsent manifests for the old revision', async () => {
    const coord = await world.as('coordinator');
    const ctx = await world.as('dispatcher');
    const { seed } = world;
    const d = '2026-10-22';
    const c = await crew(coord, seed, ['bozhidar', 'nevena'], { serviceDate: d });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      ...outbound(seed, d, [{ workerId: seed.workers.bozhidar, assignmentId: c.ids.bozhidar! }]),
    });
    await publish(ctx, t.id, t.version);
    const manifest = await generateDraft(ctx, { template: 'driver_manifest', tripId: t.id });
    await addTripPassenger(ctx, t.id, { workerId: seed.workers.nevena, assignmentId: c.ids.nevena!, boardStopSeq: 1, alightStopSeq: 2 });
    const [m] = await read(ctx, (tx) => tx.select().from(messageDrafts).where(eq(messageDrafts.id, manifest.id)));
    expect(m!.state).toBe('superseded');
  });

  it('cancelled passengers and a driver-own shift belonging to someone else block publication', async () => {
    const coord = await world.as('coordinator');
    const ctx = await world.as('dispatcher');
    const { seed } = world;
    const d = '2026-10-23';
    const c = await crew(coord, seed, ['kaloyan', 'desislava'], { serviceDate: d });
    const { releaseAssignment } = await import('@cds/domain');
    await releaseAssignment(coord, c.ids.desislava!, 'Client reduced numbers');
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      ...outbound(seed, d, [{ workerId: seed.workers.desislava, assignmentId: c.ids.desislava! }]),
      driverOwnAssignmentId: c.ids.kaloyan!, // Mo is the driver; this is Kaloyan's shift
      stops: [
        { purpose: 'pickup', label: 'Town square' },
        { purpose: 'dropoff', label: 'Drop', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 30 },
        { purpose: 'driver_own_work', label: 'Gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 0 },
      ],
    });
    const codes = (await validateTrip(ctx, t.id)).violations.filter((v) => v.severity === 'error').map((v) => v.code);
    expect(codes).toEqual(expect.arrayContaining(['PASSENGER_NOT_BOOKED', 'DRIVER_OWN_SHIFT_MISMATCH']));
  });
});

describe('site entrance validation', () => {
  it('a passenger dropped at another site entrance is an error', async () => {
    const coord = await world.as('coordinator');
    const ctx = await world.as('dispatcher');
    const { seed } = world;
    const d = '2026-10-24';
    const c = await crew(coord, seed, ['ognyan'], { serviceDate: d });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      ...outbound(seed, d, [{ workerId: seed.workers.ognyan, assignmentId: c.ids.ognyan! }], seed.locations.coldStoreGate),
    });
    const codes = (await validateTrip(ctx, t.id)).violations.map((v) => v.code);
    expect(codes).toContain('WRONG_DESTINATION');
  });

  it('an entrance outside its validity dates blocks dispatch and is never sent', async () => {
    const coord = await world.as('coordinator');
    const ctx = await world.as('dispatcher');
    const { seed, tdb } = world;
    const d = '2026-10-25';
    const [old] = await tdb.ownerDb
      .insert(workLocations)
      .values({
        organisationId: seed.organisationId,
        siteId: seed.sites.packhouse,
        name: 'Old north gate',
        pinText: 'old-gate-pin',
        verifiedAt: new Date('2026-01-01T00:00:00Z'),
        validTo: '2026-09-30',
      })
      .returning();
    const c = await crew(coord, seed, ['radka'], { serviceDate: d, workLocationId: old!.id });
    const status = (await getOrderDetail(coord, c.order.id)).lines[0]!.status;
    expect(status.blockers.map((b) => b.code)).toContain('SITE_UNVERIFIED');
    await expect(generateDraft(coord, { template: 'worker_booking', assignmentId: c.ids.radka! })).rejects.toMatchObject({ code: 'SITE_UNVERIFIED' });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      ...outbound(seed, d, [{ workerId: seed.workers.radka, assignmentId: c.ids.radka! }], old!.id),
    });
    expect((await validateTrip(ctx, t.id)).violations.map((v) => v.code)).toContain('SITE_UNVERIFIED');
  });

  it('a return journey cannot send an unverified site pickup to the driver', async () => {
    const coord = await world.as('coordinator');
    const ctx = await world.as('dispatcher');
    const { seed } = world;
    const d = '2026-10-26';
    const c = await crew(coord, seed, ['lazar'], { serviceDate: d, siteId: seed.sites.field, workLocationId: seed.locations.fieldEntrance });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'return',
      driverId: seed.drivers.mo,
      vehicleId: seed.vehicles.minibus,
      plannedDepartureAt: `${d}T15:00:00+01:00`,
      estimatedEndAt: `${d}T15:40:00+01:00`,
      stops: [
        { purpose: 'pickup', label: 'Field entrance', workLocationId: seed.locations.fieldEntrance },
        { purpose: 'dropoff', label: 'Town square', travelMinutesFromPrevious: 30 },
      ],
      passengers: [{ workerId: seed.workers.lazar, assignmentId: c.ids.lazar!, boardStopSeq: 1, alightStopSeq: 2 }],
    });
    await expect(generateDraft(ctx, { template: 'driver_manifest', tripId: t.id })).rejects.toMatchObject({ code: 'SITE_UNVERIFIED' });
  });

  it('an order line cannot use another site entrance, and moving site clears the old entrance', async () => {
    const coord = await world.as('coordinator');
    const { seed } = world;
    const s = await source(coord, seed, 'two packers');
    await expect(
      createOrder(coord, {
        branchId: seed.branches.north,
        clientId: seed.clients.growers,
        sourceMessageIds: [s.id],
        lines: [line(seed, { workLocationId: seed.locations.coldStoreGate })],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const o = await acceptedOrder(coord, seed, [line(seed, { serviceDate: '2026-10-27' })]);
    const input = {
      expectedVersion: o.version,
      sourceMessageIds: [o.sourceId],
      reason: 'Moved to the field',
      lineChanges: [{ lineId: o.lines[0]!.id, siteId: seed.sites.field }],
    };
    const p = await previewAmendment(coord, o.id, input);
    expect(p.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['siteId', 'workLocationId']));
    await amendOrder(coord, o.id, { ...input, acknowledgeImpactToken: p.token });
    const [l] = await read(coord, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, o.lines[0]!.id)));
    expect(l!.siteId).toBe(seed.sites.field);
    expect(l!.workLocationId).toBeNull();
  });
});

describe('conflict checks before messages', () => {
  it('a conflict raised after drafting stops the draft being recorded as sent', async () => {
    const coord = await world.as('coordinator');
    const { seed } = world;
    const c = await crew(coord, seed, ['siyana'], { serviceDate: '2026-10-28', endLocal: '15:00' });
    const draft = await generateDraft(coord, { template: 'worker_booking', assignmentId: c.ids.siyana! });
    await raiseConflict(coord, c.order.id, { lineId: c.line.id, fieldPath: 'start time', observations: [{ value: '07:00' }, { value: '06:30' }] });
    await expect(
      markManuallySent(coord, draft.id, { expectedVersion: 1, channel: 'whatsapp_manual', sentAt: '2026-10-27T18:00:00+01:00' }),
    ).rejects.toMatchObject({
      code: 'SOURCE_CONFLICT',
    });
  });

  it("a conflict on a passenger's order blocks publication and the driver manifest", async () => {
    const coord = await world.as('coordinator');
    const ctx = await world.as('dispatcher');
    const { seed } = world;
    const d = '2026-10-29';
    const c = await crew(coord, seed, ['petar_a'], { serviceDate: d });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      ...outbound(seed, d, [{ workerId: seed.workers.petar_a, assignmentId: c.ids.petar_a! }]),
    });
    await proposeTripToDriver(ctx, t.id, t.version);
    const a = await recordTripAcceptance(ctx, t.id, { revisionNo: 1, decision: 'accepted', method: 'phone', decidedAt: '2026-10-28T19:00:00+01:00' });
    await raiseConflict(coord, c.order.id, { fieldPath: 'site', observations: [{ value: 'packhouse' }, { value: 'field' }] });
    await expect(publishTrip(ctx, t.id, a.version)).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
    await expect(generateDraft(ctx, { template: 'driver_manifest', tripId: t.id })).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
  });
});
