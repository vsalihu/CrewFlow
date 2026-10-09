import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DomainError } from '@cds/contracts';
import { cases, drivers, tasks, transportRequirements, trips } from '@cds/db';
import {
  addTripPassenger,
  createTrip,
  listDrivers,
  proposeAssignments,
  proposeTripToDriver,
  publishTrip,
  read,
  recordTripAcceptance,
  recordWorkerResponse,
  reportTripDisruption,
  requestReturnPickup,
  reviseTrip,
  setTransportRequirement,
  setTripProgress,
  validateTrip,
  type ServiceContext,
} from '@cds/domain';
import type { Seed } from '@cds/test-fixtures';
import { acceptedOrder, line, useWorld } from './support';

const world = useWorld();
const DATE = '2026-10-10';
const at = (hhmm: string) => `${DATE}T${hhmm}:00+01:00`;

async function confirmedCrew(ctx: ServiceContext, seed: Seed, keys: (keyof Seed['workers'])[], overrides = {}, label: string | null = null) {
  const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: keys.length, ...overrides })]);
  const l = o.lines[0]!;
  const { assignmentIds } = await proposeAssignments(ctx, l.id, { workers: keys.map((k) => ({ workerId: seed.workers[k], rawTransportLabel: label })) });
  for (const id of assignmentIds) {
    await recordWorkerResponse(ctx, id, { lineVersion: l.lineVersion, response: 'accepted', channel: 'phone', respondedAt: '2026-10-09T18:00:00+01:00' });
  }
  return { order: o, line: l, ids: Object.fromEntries(keys.map((k, i) => [k, assignmentIds[i]!])) as Record<string, string> };
}

function codes(e: unknown): string[] {
  return (e as DomainError).violations.map((v) => v.code as string);
}

describe('transport rules', () => {
  it('AT06/AT08: OWN after every name creates no drivers and no seats; only explicit records can drive', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const before = await read(ctx, (tx) => tx.select().from(drivers));
    const crew = await confirmedCrew(ctx, seed, ['ognyan', 'radka', 'lazar'], { serviceDate: '2026-10-11' }, 'OWN');
    const after = await read(ctx, (tx) => tx.select().from(drivers));
    expect(after).toHaveLength(before.length);
    const reqs = await read(ctx, (tx) => tx.select().from(transportRequirements).where(eq(transportRequirements.assignmentId, crew.ids.lazar!)));
    expect(reqs.map((r) => [r.leg, r.mode, r.rawLabel]).sort()).toEqual([
      ['outbound', 'unresolved', 'OWN'],
      ['return', 'unresolved', 'OWN'],
    ]);
    const list = await listDrivers(ctx, seed.branches.north);
    expect(list.map((d) => d.displayName)).not.toContain('Lazar Hristakiev');
    await expect(
      createTrip(ctx, {
        branchId: seed.branches.north,
        serviceDate: '2026-10-11',
        legType: 'outbound',
        driverId: crew.ids.lazar, // an assignment id is not a driver record
        stops: [
          { purpose: 'pickup', label: 'Town square' },
          { purpose: 'dropoff', label: 'Packhouse', workLocationId: seed.locations.packhouseGate },
        ],
      }),
    ).rejects.toThrow(/Only people with an explicit driver record/);
  });

  it('AT10: four passenger seats and five people on one segment is rejected', async () => {
    const ctx = await world.as('dispatcher');
    const coord = await world.as('coordinator');
    const { seed } = world;
    const crew = await confirmedCrew(coord, seed, ['mira', 'teodor', 'ralitsa', 'bozhidar', 'nevena']);
    const err = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: DATE,
      legType: 'outbound',
      driverId: seed.drivers.mo,
      vehicleId: seed.vehicles.car,
      plannedDepartureAt: at('06:00'),
      estimatedEndAt: at('06:40'),
      stops: [
        { purpose: 'pickup', label: 'Town square' },
        { purpose: 'dropoff', label: 'Packhouse gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 30 },
      ],
      passengers: Object.entries(crew.ids).map(([k, id]) => ({ workerId: seed.workers[k as keyof Seed['workers']], assignmentId: id, boardStopSeq: 1, alightStopSeq: 2 })),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('CAPACITY_EXCEEDED');
    expect((err as DomainError).message).toContain('5 passengers');
  });

  it('AT09/AT18: a proposed driver who has not accepted blocks publication; a route change invalidates acceptance', async () => {
    const ctx = await world.as('dispatcher');
    const coord = await world.as('coordinator');
    const { seed } = world;
    const crew = await confirmedCrew(coord, seed, ['desislava', 'kaloyan'], { serviceDate: '2026-10-12' });
    const d = '2026-10-12';
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      driverId: seed.drivers.mo,
      vehicleId: seed.vehicles.car,
      plannedDepartureAt: `${d}T06:00:00+01:00`,
      estimatedEndAt: `${d}T06:45:00+01:00`,
      stops: [
        { purpose: 'pickup', label: 'Town square' },
        { purpose: 'dropoff', label: 'Packhouse gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 30 },
      ],
      passengers: [{ workerId: seed.workers.desislava, assignmentId: crew.ids.desislava!, boardStopSeq: 1, alightStopSeq: 2 }],
    });
    const v1 = await validateTrip(ctx, t.id);
    expect(v1.violations.filter((v) => v.severity === 'error')).toEqual([]);
    const p = await proposeTripToDriver(ctx, t.id, t.version);
    const callTasks = await read(ctx, (tx) => tx.select().from(tasks).where(and(eq(tasks.entityId, t.id), eq(tasks.type, 'confirm_driver'), eq(tasks.state, 'open'))));
    expect(callTasks[0]!.title).toContain('Call Mo Ferrant');
    const e1 = await publishTrip(ctx, t.id, p.version).catch((e) => e);
    expect((e1 as DomainError).code).toBe('STALE_CONFIRMATION');

    const acc = await recordTripAcceptance(ctx, t.id, { revisionNo: 1, decision: 'accepted', method: 'phone', decidedAt: '2026-10-11T19:00:00+01:00' });
    expect(acc.state).toBe('driver_accepted');
    // A pickup is added after acceptance: new revision, acceptance no longer applies.
    const add = await addTripPassenger(ctx, t.id, { workerId: seed.workers.kaloyan, assignmentId: crew.ids.kaloyan!, boardStopSeq: 1, alightStopSeq: 2 });
    expect(add.revisionNo).toBe(2);
    const e2 = await publishTrip(ctx, t.id, add.version).catch((e) => e);
    expect((e2 as DomainError).code).toBe('STALE_CONFIRMATION');
    const stale = await recordTripAcceptance(ctx, t.id, { revisionNo: 1, decision: 'accepted', method: 'phone', decidedAt: '2026-10-11T19:30:00+01:00' });
    expect(stale.outcome).toBe('stale');
    const ok = await recordTripAcceptance(ctx, t.id, { revisionNo: 2, decision: 'accepted', method: 'phone', decidedAt: '2026-10-11T19:40:00+01:00' });
    const pub = await publishTrip(ctx, t.id, ok.version);
    expect(pub.revisionNo).toBe(2);
    const reqs = await read(ctx, (tx) => tx.select().from(transportRequirements).where(and(eq(transportRequirements.assignmentId, crew.ids.kaloyan!), eq(transportRequirements.leg, 'outbound'))));
    expect(reqs[0]!.mode).toBe('agency_trip');
  });

  it('AT07: a private couple cannot have extra passengers added', async () => {
    const ctx = await world.as('dispatcher');
    const coord = await world.as('coordinator');
    const { seed } = world;
    const d = '2026-10-13';
    const crew = await confirmedCrew(coord, seed, ['stoyko', 'velina'], { serviceDate: d });
    const other = await confirmedCrew(coord, seed, ['siyana'], { serviceDate: d, role: 'Packer', endLocal: '15:00' });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      driverId: seed.drivers.stoyko,
      vehicleId: seed.vehicles.privateCar,
      plannedDepartureAt: `${d}T06:00:00+01:00`,
      estimatedEndAt: `${d}T06:40:00+01:00`,
      driverOwnAssignmentId: crew.ids.stoyko!,
      stops: [
        { purpose: 'pickup', label: 'Home' },
        { purpose: 'driver_own_work', label: 'Packhouse gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 30 },
      ],
      passengers: [{ workerId: seed.workers.velina, assignmentId: crew.ids.velina!, boardStopSeq: 1, alightStopSeq: 2 }],
    });
    const ok = await validateTrip(ctx, t.id);
    expect(ok.violations.filter((v) => v.code === 'PRIVATE_PARTY_CONFLICT')).toEqual([]);
    // The car has four seats, but the household's explicit restriction wins.
    await addTripPassenger(ctx, t.id, { workerId: seed.workers.siyana, assignmentId: other.ids.siyana!, boardStopSeq: 1, alightStopSeq: 2 });
    const bad = await validateTrip(ctx, t.id);
    expect(bad.violations.map((v) => v.code)).toContain('PRIVATE_PARTY_CONFLICT');
  });

  it('AT11: multi-drop capacity is per segment, and the driver must still reach their own shift on time', async () => {
    const ctx = await world.as('dispatcher');
    const coord = await world.as('coordinator');
    const { seed } = world;
    const d = '2026-10-14';
    const pack = await confirmedCrew(coord, seed, ['mira', 'teodor', 'ralitsa', 'bozhidar'], { serviceDate: d });
    const cold = await confirmedCrew(coord, seed, ['nevena', 'desislava'], { serviceDate: d, role: 'Packer', arrivalLocal: '07:20', startLocal: '07:30' });
    const own = await confirmedCrew(coord, seed, ['ivo'], { serviceDate: d, role: 'Supervisor', arrivalLocal: '07:00', startLocal: '07:10' });
    const manifest = (minutesToOwn: number) => ({
      driverId: seed.drivers.ivo,
      vehicleId: seed.vehicles.car,
      plannedDepartureAt: `${d}T06:00:00+01:00`,
      estimatedEndAt: `${d}T07:05:00+01:00`,
      driverOwnAssignmentId: own.ids.ivo!,
      stops: [
        { purpose: 'pickup' as const, label: 'Town square' },
        { purpose: 'dropoff' as const, label: 'Packhouse gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 20 },
        { purpose: 'pickup' as const, label: 'Second pickup', travelMinutesFromPrevious: 5 },
        { purpose: 'dropoff' as const, label: 'Cold store yard', workLocationId: seed.locations.coldStoreGate, travelMinutesFromPrevious: 15 },
        { purpose: 'driver_own_work' as const, label: 'Packhouse gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: minutesToOwn },
      ],
      passengers: [
        ...Object.entries(pack.ids).map(([k, id]) => ({ workerId: seed.workers[k as keyof Seed['workers']], assignmentId: id, boardStopSeq: 1, alightStopSeq: 2 })),
        ...Object.entries(cold.ids).map(([k, id]) => ({ workerId: seed.workers[k as keyof Seed['workers']], assignmentId: id, boardStopSeq: 3, alightStopSeq: 4 })),
      ],
    });
    // Six passengers in a four-seat car is fine: never more than four on any segment.
    const t = await createTrip(ctx, { branchId: seed.branches.north, serviceDate: d, legType: 'outbound', ...manifest(10) });
    expect((await validateTrip(ctx, t.id)).violations.filter((v) => v.severity === 'error')).toEqual([]);
    // A longer final leg makes the driver late for their own shift.
    await reviseTrip(ctx, t.id, { expectedVersion: 1, reason: 'Slower road', ...manifest(25) });
    const late = await validateTrip(ctx, t.id);
    expect(late.violations.find((v) => v.code === 'LATE_ARRIVAL' && v.subject === 'driver')).toBeTruthy();
  });

  it('blocks publication to an unverified field entrance or a vehicle with unknown capacity', async () => {
    const ctx = await world.as('dispatcher');
    const coord = await world.as('coordinator');
    const { seed } = world;
    const d = '2026-10-15';
    const crew = await confirmedCrew(coord, seed, ['ognyan'], { serviceDate: d, siteId: seed.sites.field, workLocationId: seed.locations.fieldEntrance });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      driverId: seed.drivers.mo,
      vehicleId: seed.vehicles.unknownCar,
      plannedDepartureAt: `${d}T06:00:00+01:00`,
      estimatedEndAt: `${d}T06:40:00+01:00`,
      stops: [
        { purpose: 'pickup', label: 'Town square' },
        { purpose: 'dropoff', label: 'Field entrance', workLocationId: seed.locations.fieldEntrance, travelMinutesFromPrevious: 25 },
      ],
      passengers: [{ workerId: seed.workers.ognyan, assignmentId: crew.ids.ognyan!, boardStopSeq: 1, alightStopSeq: 2 }],
    });
    const p = await proposeTripToDriver(ctx, t.id, t.version);
    const a = await recordTripAcceptance(ctx, t.id, { revisionNo: 1, decision: 'accepted', method: 'phone', decidedAt: '2026-10-14T19:00:00+01:00' });
    expect(a.version).toBe(p.version + 1);
    const e = await publishTrip(ctx, t.id, a.version).catch((x) => x);
    expect(codes(e)).toEqual(expect.arrayContaining(['CAPACITY_UNKNOWN', 'SITE_UNVERIFIED']));
  });

  it('AT44: two people added at once to the last seat: one commits, the other gets a capacity conflict', async () => {
    const ctx = await world.as('dispatcher');
    const ctx2 = await world.as('manager');
    const coord = await world.as('coordinator');
    const { seed } = world;
    const d = '2026-10-16';
    const crew = await confirmedCrew(coord, seed, ['mira', 'teodor', 'ralitsa', 'bozhidar', 'nevena'], { serviceDate: d });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      driverId: seed.drivers.mo,
      vehicleId: seed.vehicles.car,
      plannedDepartureAt: `${d}T06:00:00+01:00`,
      estimatedEndAt: `${d}T06:40:00+01:00`,
      stops: [
        { purpose: 'pickup', label: 'Town square' },
        { purpose: 'dropoff', label: 'Packhouse gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 30 },
      ],
      passengers: (['mira', 'teodor', 'ralitsa'] as const).map((k) => ({ workerId: seed.workers[k], assignmentId: crew.ids[k]!, boardStopSeq: 1, alightStopSeq: 2 })),
    });
    const results = await Promise.allSettled([
      addTripPassenger(ctx, t.id, { workerId: seed.workers.bozhidar, assignmentId: crew.ids.bozhidar!, boardStopSeq: 1, alightStopSeq: 2 }),
      addTripPassenger(ctx2, t.id, { workerId: seed.workers.nevena, assignmentId: crew.ids.nevena!, boardStopSeq: 1, alightStopSeq: 2 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as DomainError).code).toBe('CAPACITY_EXCEEDED');
  });

  it('AT12/AT13: a breakdown affects every passenger; the return leg stays open after the outbound completes', async () => {
    const ctx = await world.as('dispatcher');
    const coord = await world.as('coordinator');
    const { seed, clock } = world;
    const d = '2026-10-17';
    const crew = await confirmedCrew(coord, seed, ['kaloyan', 'radka'], { serviceDate: d, endLocal: null });
    const t = await createTrip(ctx, {
      branchId: seed.branches.north,
      serviceDate: d,
      legType: 'outbound',
      driverId: seed.drivers.mo,
      vehicleId: seed.vehicles.minibus,
      plannedDepartureAt: `${d}T06:00:00+01:00`,
      estimatedEndAt: `${d}T06:40:00+01:00`,
      stops: [
        { purpose: 'pickup', label: 'Town square' },
        { purpose: 'dropoff', label: 'Packhouse gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 30 },
      ],
      passengers: (['kaloyan', 'radka'] as const).map((k) => ({ workerId: seed.workers[k], assignmentId: crew.ids[k]!, boardStopSeq: 1, alightStopSeq: 2 })),
    });
    await proposeTripToDriver(ctx, t.id, 1);
    const acc = await recordTripAcceptance(ctx, t.id, { revisionNo: 1, decision: 'accepted', method: 'phone', decidedAt: `${d}T05:00:00+01:00` });
    const pub = await publishTrip(ctx, t.id, acc.version);
    const dep = await setTripProgress(ctx, t.id, 'departed', pub.version);
    const dis = await reportTripDisruption(ctx, t.id, { kind: 'breakdown', note: 'Minibus broke down on the drove road' });
    expect(dis.affectedPassengers).toBe(2);
    const [c] = await read(ctx, (tx) => tx.select().from(cases).where(eq(cases.id, dis.caseId)));
    expect((c!.affected as { passengers: unknown[] }).passengers).toHaveLength(2);
    const eta = await read(ctx, (tx) => tx.select().from(tasks).where(and(eq(tasks.type, 'client_eta_update'), eq(tasks.entityId, crew.order.id))));
    expect(eta).toHaveLength(1);
    const [trip] = await read(ctx, (tx) => tx.select().from(trips).where(eq(trips.id, t.id)));
    await setTripProgress(ctx, t.id, 'completed', trip!.version);
    expect(dep.version).toBeGreaterThan(pub.version);

    // Unknown finish: the return is the dispatcher's to arrange, which is not the same as booked.
    await setTransportRequirement(ctx, crew.ids.kaloyan!, { leg: 'return', mode: 'unresolved', accountableMembershipId: seed.staff.dispatcher.membershipId, arrangementNote: 'Supervisor will message when they finish' });
    const ret = await read(ctx, (tx) => tx.select().from(transportRequirements).where(and(eq(transportRequirements.assignmentId, crew.ids.kaloyan!), eq(transportRequirements.leg, 'return'))));
    expect(ret[0]!.mode).toBe('unresolved');
    clock.set(`${d}T19:55:00Z`);
    const r = await requestReturnPickup(ctx, { assignmentIds: [crew.ids.kaloyan!, crew.ids.radka!], pickupAt: new Date(`${d}T20:45:00+01:00`), reason: 'finished' });
    const urgent = await read(ctx, (tx) => tx.select().from(tasks).where(eq(tasks.id, r.taskIds[0]!)));
    expect(urgent[0]!.priority).toBe('urgent');
    clock.set('2026-10-09T17:00:00Z');
  });

  it('AT14: an unwell worker gets an owned urgent pickup and a case whose reason stays restricted', async () => {
    const ctx = await world.as('dispatcher');
    const coord = await world.as('coordinator');
    const { seed } = world;
    const crew = await confirmedCrew(coord, seed, ['lazar'], { serviceDate: '2026-10-18' });
    const r = await requestReturnPickup(ctx, { assignmentIds: [crew.ids.lazar!], pickupAt: new Date('2026-10-18T10:00:00+01:00'), reason: 'unwell', restrictedNote: 'Feeling faint' });
    const [t] = await read(ctx, (tx) => tx.select().from(tasks).where(eq(tasks.id, r.taskIds[0]!)));
    expect(t!.ownerMembershipId).toBe(seed.staff.dispatcher.membershipId);
    expect(t!.title).not.toContain('faint');
    const [c] = await read(ctx, (tx) => tx.select().from(cases).where(eq(cases.id, r.caseId!)));
    expect(c!.restrictedNotes).toBe('Feeling faint');
    expect(c!.summary).not.toContain('faint');
  });
});
