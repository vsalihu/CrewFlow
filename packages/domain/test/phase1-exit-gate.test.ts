// Phase 1 exit gate (build plan §25): "a synthetic ten-person booking can be planned without
// inferring drivers; the source time conflict remains blocked until resolved; one worker
// declines, one driver changes and one client cancellation are handled end to end."
// Everything here goes through the real domain services against real PostgreSQL.

import { describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { assignments, drivers, externalBookings, orderLines, tasks, trips } from '@cds/db';
import {
  acknowledgeHandover,
  addDutyPeriod,
  amendOrder,
  cancelOrder,
  captureSource,
  createHandover,
  createOrder,
  createTrip,
  decideAcceptance,
  generateDraft,
  getOrderDetail,
  listCandidates,
  listExternalBookingQueue,
  markManuallySent,
  operationsBoard,
  previewAmendment,
  proposeAssignments,
  proposeTripToDriver,
  publishTrip,
  raiseConflict,
  read,
  recordTripAcceptance,
  recordWorkerResponse,
  resolveConflict,
  reviseTrip,
  setTransportRequirement,
  updateExternalBooking,
  type ServiceContext,
} from '@cds/domain';
import type { Seed } from '@cds/test-fixtures';
import { useWorld } from './support';

const world = useWorld('2026-10-08T19:29:00Z'); // 20:29 local, the evening before
const DATE = '2026-10-09';
const local = (hhmm: string) => `${DATE}T${hhmm}:00+01:00`;

async function lineStatus(ctx: ServiceContext, orderId: string) {
  const d = await getOrderDetail(ctx, orderId);
  return d.lines[0]!.status;
}

describe('Phase 1 exit gate', () => {
  it('plans a ten-person booking end to end', async () => {
    const { seed, tdb } = world;
    const coord = await world.as('coordinator');
    const dispatcher = await world.as('dispatcher');
    const manager = await world.as('manager');
    const W = seed.workers;

    // Duty rota: the coordinator covers this evening.
    await addDutyPeriod(manager, {
      branchId: seed.branches.north,
      membershipId: seed.staff.coordinator.membershipId,
      backupMembershipId: seed.staff.coordinator2.membershipId,
      startsAt: new Date('2026-10-08T16:00:00Z'),
      endsAt: new Date('2026-10-08T23:00:00Z'),
    });

    // --- 1. Late request: the client message and the internal booking disagree on the time.
    const clientMsg = await captureSource(coord, {
      branchId: seed.branches.north,
      kind: 'pasted_message',
      rawText: 'Need 10 graders at the packhouse tomorrow, can they be there for 6:30',
      receivedAt: '2026-10-08T20:29:00+01:00',
      senderLabel: 'Gwen Tasker (synthetic)',
    });
    const internal = await captureSource(coord, {
      branchId: seed.branches.north,
      kind: 'phone_note',
      rawText: 'Booked 10 staff, 07:00 start',
      receivedAt: '2026-10-08T20:32:00+01:00',
      callerName: 'Gwen Tasker',
    });
    const order = await createOrder(coord, {
      branchId: seed.branches.north,
      clientId: seed.clients.growers,
      clientContactId: seed.contacts.growers,
      sourceMessageIds: [clientMsg.id, internal.id],
      lines: [
        {
          serviceDate: DATE,
          siteId: seed.sites.packhouse,
          workLocationId: seed.locations.packhouseGate,
          role: 'Grader',
          requestedCount: 10,
          arrivalLocal: '06:50',
          startLocal: '07:00',
          endLocal: '15:00',
        },
      ],
    });
    expect(order.urgency).toBe('late');
    const lateTask = await read(coord, (tx) =>
      tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.entityId, order.id), eq(tasks.type, 'late_order_review'))),
    );
    expect(lateTask[0]!.ownerMembershipId).toBe(seed.staff.coordinator.membershipId);
    const [line] = await read(coord, (tx) => tx.select().from(orderLines).where(eq(orderLines.orderId, order.id)));
    const conflict = await raiseConflict(coord, order.id, {
      lineId: line!.id,
      fieldPath: 'arrival/start',
      observations: [
        { value: 'arrive 06:30', sourceMessageId: clientMsg.id },
        { value: 'start 07:00', sourceMessageId: internal.id },
      ],
    });

    // --- 2. Accept, and propose ten eligible people. Ineligible people are explained, not hidden.
    let v = (await decideAcceptance(coord, order.id, { expectedVersion: 1, decisions: [{ lineId: line!.id, acceptedCount: 10 }] })).version;
    const candidates = await listCandidates(coord, line!.id);
    expect(candidates.find((c) => c.workerId === W.yordan)!.exclusions[0]!.code).toBe('READINESS_BLOCKED');
    expect(candidates.find((c) => c.workerId === W.emil)!.eligible).toBe(false);
    const team: (keyof Seed['workers'])[] = ['ivo', 'mira', 'teodor', 'ralitsa', 'bozhidar', 'nevena', 'kaloyan', 'desislava', 'stoyko', 'velina'];
    const { assignmentIds } = await proposeAssignments(coord, line!.id, { workers: team.map((k) => ({ workerId: W[k], rawTransportLabel: 'OWN' })) });
    const A = Object.fromEntries(team.map((k, i) => [k, assignmentIds[i]!])) as Record<string, string>;

    // The conflict blocks every instruction until a person resolves it.
    await expect(generateDraft(coord, { template: 'worker_offer', assignmentId: A.mira! })).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
    expect((await lineStatus(coord, order.id)).blockers.map((b) => b.code)).toContain('SOURCE_CONFLICT');
    await resolveConflict(coord, conflict.id, {
      resolvedValue: 'arrive 06:30, start 07:00',
      note: 'Called Gwen: arrive 06:30 for induction, paid start 07:00',
    });
    const fix = {
      expectedVersion: v,
      sourceMessageIds: [clientMsg.id],
      reason: 'Conflict resolved: arrive 06:30',
      lineChanges: [{ lineId: line!.id, arrivalLocal: '06:30' }],
    };
    const preview = await previewAmendment(coord, order.id, fix);
    v = (await amendOrder(coord, order.id, { ...fix, acknowledgeImpactToken: preview.token })).version;
    const [l2] = await read(coord, (tx) => tx.select().from(orderLines).where(eq(orderLines.id, line!.id)));

    // --- 3. Offers go out; nine accept, one declines and is replaced.
    for (const k of team) {
      const d = await generateDraft(coord, { template: 'worker_offer', assignmentId: A[k]! });
      await markManuallySent(coord, d.id, { expectedVersion: 1, channel: 'whatsapp_manual', sentAt: '2026-10-08T20:50:00+01:00' });
    }
    for (const k of team) {
      await recordWorkerResponse(coord, A[k]!, {
        lineVersion: l2!.lineVersion,
        response: k === 'nevena' ? 'declined' : 'accepted',
        channel: 'whatsapp_manual',
        respondedAt: '2026-10-08T21:00:00+01:00',
      });
    }
    const replace = await read(coord, (tx) =>
      tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.entityId, line!.id), eq(tasks.type, 'find_replacement'), eq(tasks.state, 'open'))),
    );
    expect(replace).toHaveLength(1);
    const rep = await proposeAssignments(coord, line!.id, { workers: [{ workerId: W.radka }] });
    A.radka = rep.assignmentIds[0]!;
    await recordWorkerResponse(coord, A.radka, {
      lineVersion: l2!.lineVersion,
      response: 'accepted',
      channel: 'phone',
      respondedAt: '2026-10-08T21:10:00+01:00',
    });
    const crew = team.filter((k) => k !== 'nevena').concat('radka');
    expect((await lineStatus(coord, order.id)).confirmed).toBe(10);

    // --- 4. Transport. Nobody became a driver because of "OWN"; driving is explicit.
    const driverCount = (await read(coord, (tx) => tx.select().from(drivers))).length;
    expect(driverCount).toBe(3);
    // The couple travel privately together; that is confirmed, not inferred.
    for (const k of ['stoyko', 'velina'] as const) {
      for (const leg of ['outbound', 'return'] as const) {
        await setTransportRequirement(dispatcher, A[k]!, {
          leg,
          mode: 'private_confirmed',
          arrangementNote: 'Stoyko confirmed by phone he drives Velina only (synthetic)',
        });
      }
    }
    const riders = crew.filter((k) => !['stoyko', 'velina', 'ivo'].includes(k));
    const stops = (own: boolean) => [
      { purpose: 'pickup' as const, label: 'Town square' },
      { purpose: 'dropoff' as const, label: 'Packhouse staff gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 30 },
      ...(own
        ? [{ purpose: 'driver_own_work' as const, label: 'Packhouse staff gate', workLocationId: seed.locations.packhouseGate, travelMinutesFromPrevious: 0 }]
        : []),
    ];
    const trip = await createTrip(dispatcher, {
      branchId: seed.branches.north,
      serviceDate: DATE,
      legType: 'outbound',
      driverId: seed.drivers.ivo,
      vehicleId: seed.vehicles.minibus,
      plannedDepartureAt: local('05:40'),
      estimatedEndAt: local('06:15'),
      driverOwnAssignmentId: A.ivo!,
      stops: stops(true),
      passengers: riders.map((k) => ({ workerId: W[k], assignmentId: A[k]!, boardStopSeq: 1, alightStopSeq: 2 })),
    });
    await proposeTripToDriver(dispatcher, trip.id, trip.version);
    let tv = (await recordTripAcceptance(dispatcher, trip.id, { revisionNo: 1, decision: 'accepted', method: 'phone', decidedAt: '2026-10-08T21:30:00+01:00' }))
      .version;
    tv = (await publishTrip(dispatcher, trip.id, tv)).version;
    // Returns: finish is 15:00 but the client often changes it, so the dispatcher owns the return.
    for (const k of crew.filter((x) => !['stoyko', 'velina'].includes(x))) {
      await setTransportRequirement(dispatcher, A[k]!, {
        leg: 'return',
        mode: 'unresolved',
        accountableMembershipId: seed.staff.dispatcher.membershipId,
        arrangementNote: 'Supervisor to message at finish',
      });
    }

    // --- 5. One driver changes: Ivo can no longer drive, Mo takes the minibus.
    const rev = await reviseTrip(dispatcher, trip.id, {
      expectedVersion: tv,
      reason: 'Ivo unavailable to drive; Mo takes the minibus',
      driverId: seed.drivers.mo,
      vehicleId: seed.vehicles.minibus,
      plannedDepartureAt: local('05:40'),
      estimatedEndAt: local('06:15'),
      stops: stops(false),
      passengers: [...riders, 'ivo'].map((k) => ({ workerId: W[k as keyof Seed['workers']], assignmentId: A[k]!, boardStopSeq: 1, alightStopSeq: 2 })),
    });
    expect(rev.state).toBe('proposed');
    expect((await lineStatus(coord, order.id)).blockers.map((b) => b.code)).toContain('JOURNEY_UNCONFIRMED');
    await expect(publishTrip(dispatcher, trip.id, rev.version)).rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
    tv = (await recordTripAcceptance(dispatcher, trip.id, { revisionNo: 2, decision: 'accepted', method: 'phone', decidedAt: '2026-10-08T22:00:00+01:00' }))
      .version;
    await publishTrip(dispatcher, trip.id, tv);

    // Everything else is in place; only the JoinedUp verification is still missing.
    expect((await lineStatus(coord, order.id)).blockers.map((b) => b.code)).toEqual(['EXTERNAL_UNVERIFIED']);

    // --- 6. JoinedUp: each booking entered and verified by a person, for the current version.
    const queue = await listExternalBookingQueue(coord, seed.branches.north);
    const mine = queue.filter((q) => crew.some((k) => A[k] === q.booking.assignmentId));
    expect(mine).toHaveLength(10);
    expect(mine.find((q) => q.workerId === W.ivo)!.joinedUpWorkerId).toBe('000417'); // leading zeroes preserved
    for (const q of mine) {
      const e = await updateExternalBooking(coord, q.booking.id, {
        expectedVersion: q.booking.version,
        action: 'entered',
        externalBookingId: `JU-${q.joinedUpWorkerId}`,
      });
      await updateExternalBooking(coord, q.booking.id, {
        expectedVersion: e.version,
        action: 'verified',
        externalBookingId: `JU-${q.joinedUpWorkerId}`,
        evidenceNote: 'Checked JoinedUp booking list (synthetic)',
      });
    }
    const ready = await lineStatus(coord, order.id);
    expect(ready.blockers).toEqual([]);
    expect(ready.ready).toBe(true);
    const board = await operationsBoard(coord, { branchId: seed.branches.north, date: DATE });
    expect(board.board.find((r) => r.orderId === order.id)!.nextAction).toBe('Ready');

    // --- 7. Client cancellation: only eight needed; two people already told are released.
    const cut = await captureSource(coord, {
      branchId: seed.branches.north,
      kind: 'pasted_message',
      rawText: 'Only need 8 tomorrow sorry',
      receivedAt: '2026-10-08T22:15:00+01:00',
    });
    const reduce = {
      expectedVersion: v + 0,
      sourceMessageIds: [cut.id],
      reason: 'Client reduced to 8',
      lineChanges: [{ lineId: line!.id, requestedCount: 8 }],
    };
    const current = await getOrderDetail(coord, order.id);
    reduce.expectedVersion = current.order.version;
    const p2 = await previewAmendment(coord, order.id, reduce);
    expect(p2.excessAssignments).toEqual([{ lineId: line!.id, accepted: 8, active: 10 }]);
    await amendOrder(coord, order.id, { ...reduce, acknowledgeImpactToken: p2.token });
    const afterAmend = await getOrderDetail(coord, order.id);
    const released = ['mira', 'teodor'];
    const cancel = await cancelOrder(coord, order.id, {
      expectedVersion: afterAmend.order.version,
      scope: 'assignments',
      assignmentIds: released.map((k) => A[k]!),
      reason: 'Client reduced to 8',
      sourceMessageIds: [cut.id],
    });
    expect(cancel.cancelledAssignments).toBe(2);
    expect(cancel.acknowledgementTasks).toBe(2); // both had been sent an offer
    const followUps = await read(coord, (tx) =>
      tx
        .select({ type: tasks.type })
        .from(tasks)
        .where(and(inArray(tasks.state, ['open']), inArray(tasks.type, ['cancel_external_booking', 'review_trip', 'cancellation_ack']))),
    );
    expect(followUps.filter((t) => t.type === 'cancel_external_booking')).toHaveLength(2);
    expect(followUps.filter((t) => t.type === 'review_trip')).toHaveLength(1);
    const cancelledBookings = await read(coord, (tx) =>
      tx
        .select()
        .from(externalBookings)
        .where(
          inArray(
            externalBookings.assignmentId,
            released.map((k) => A[k]!),
          ),
        ),
    );
    expect(cancelledBookings.every((b) => b.state === 'verified')).toBe(true); // still live in JoinedUp until someone cancels it there
    for (const b of cancelledBookings) {
      await updateExternalBooking(coord, b.id, {
        expectedVersion: b.version,
        action: 'cancellation_verified',
        evidenceNote: 'Cancelled in JoinedUp and checked (synthetic)',
      });
    }
    // Dispatcher removes the two from the minibus; the driver re-confirms the smaller manifest.
    const [t3] = await read(dispatcher, (tx) => tx.select().from(trips).where(eq(trips.id, trip.id)));
    const keep = [...riders, 'ivo'].filter((k) => !released.includes(k));
    const r3 = await reviseTrip(dispatcher, trip.id, {
      expectedVersion: t3!.version,
      reason: 'Two passengers released by client',
      driverId: seed.drivers.mo,
      vehicleId: seed.vehicles.minibus,
      plannedDepartureAt: local('05:40'),
      estimatedEndAt: local('06:15'),
      stops: stops(false),
      passengers: keep.map((k) => ({ workerId: W[k as keyof Seed['workers']], assignmentId: A[k]!, boardStopSeq: 1, alightStopSeq: 2 })),
    });
    const acc3 = await recordTripAcceptance(dispatcher, trip.id, {
      revisionNo: r3.revisionNo,
      decision: 'accepted',
      method: 'phone',
      decidedAt: '2026-10-08T22:30:00+01:00',
    });
    await publishTrip(dispatcher, trip.id, acc3.version);
    const final = await lineStatus(coord, order.id);
    expect(final.requested).toBe(8);
    expect(final.confirmed).toBe(8);
    expect(final.blockers).toEqual([]);
    const live = await read(coord, (tx) =>
      tx
        .select()
        .from(assignments)
        .where(and(eq(assignments.lineId, line!.id), eq(assignments.state, 'accepted'))),
    );
    expect(live).toHaveLength(8);

    // --- 8. Handover to the next coordinator, who acknowledges it.
    const h = await createHandover(coord, {
      branchId: seed.branches.north,
      incomingMembershipId: seed.staff.coordinator2.membershipId,
      note: 'Two cancellation acknowledgements outstanding',
    });
    expect(h.taskCount).toBeGreaterThan(0);
    const next = await world.as('coordinator2');
    await acknowledgeHandover(next, h.id);
    expect(tdb).toBeTruthy();
  });
});
