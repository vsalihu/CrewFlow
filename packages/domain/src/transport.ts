import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  DomainError,
  createTripSchema,
  formatInstantLocal,
  reviseTripSchema,
  transportRequirementSchema,
  tripAcceptanceSchema,
  type CreateTripInput,
  type ReviseTripInput,
  type TransportRequirementInput,
  type TripAcceptanceInput,
  type TripManifest,
} from '@cds/contracts';
import { actorId, requireCapability } from '@cds/auth';
import {
  assignments,
  cases,
  drivers,
  messageDrafts,
  orderLines,
  orders,
  resourceReservations,
  transportRequirements,
  travelParties,
  travelPartyMembers,
  tripAcceptances,
  tripPassengers,
  tripRevisions,
  tripStops,
  trips,
  vehicles,
  workLocations,
  workers,
  type Tx,
} from '@cds/db';
import { audit, checkVersion, command, enqueue, nextReference, notFound, nowOf, read, translateDbError, type ServiceContext } from './context';
import { tstzrange } from './lines';
import { loadPolicy } from './orders';
import { closeTasksByKey, createTask } from './tasks';

export type TripViolation = { code: string; severity: 'error' | 'warning'; message: string; subject?: string };

type TripRow = typeof trips.$inferSelect;
type RevisionRow = typeof tripRevisions.$inferSelect;

// ------------------------------------------------------------------ manifest writing

function validateStructure(m: TripManifest): void {
  const errors: string[] = [];
  const n = m.stops.length;
  const seen = new Set<string>();
  for (const p of m.passengers) {
    if (seen.has(p.workerId)) errors.push('A passenger appears twice in this journey.');
    seen.add(p.workerId);
    if (p.boardStopSeq < 1 || p.boardStopSeq > n || p.alightStopSeq < 1 || p.alightStopSeq > n) errors.push('A passenger refers to a stop that does not exist.');
    else if (p.alightStopSeq <= p.boardStopSeq) errors.push('Every boarding must be followed by a later drop-off.');
    else {
      if (m.stops[p.boardStopSeq - 1]!.purpose !== 'pickup') errors.push('Passengers must board at a pickup stop.');
      if (m.stops[p.alightStopSeq - 1]!.purpose === 'pickup') errors.push('Passengers must get off at a drop-off stop.');
    }
  }
  if (m.driverOwnAssignmentId && !m.stops.some((s) => s.purpose === 'driver_own_work')) errors.push("Add the stop where the driver starts their own shift.");
  if (errors.length) throw new DomainError('VALIDATION_FAILED', [...new Set(errors)].join(' '));
}

async function writeRevision(tx: Tx, ctx: ServiceContext, trip: TripRow, revisionNo: number, m: TripManifest, reason: string): Promise<RevisionRow> {
  validateStructure(m);
  if (m.driverId) {
    const [d] = await tx.select().from(drivers).where(eq(drivers.id, m.driverId));
    if (!d) throw new DomainError('VALIDATION_FAILED', 'Driver not found. Only people with an explicit driver record can drive.');
  }
  if (m.vehicleId) {
    const [veh] = await tx.select().from(vehicles).where(eq(vehicles.id, m.vehicleId));
    if (!veh) throw new DomainError('VALIDATION_FAILED', 'Vehicle not found.');
    // Enforced here, under the trip lock, so two concurrent additions cannot both take the last seat.
    if (veh.passengerCapacity !== null) {
      for (let seg = 1; seg < m.stops.length; seg++) {
        const onBoard = m.passengers.filter((p) => p.boardStopSeq <= seg && p.alightStopSeq > seg).length;
        if (onBoard > veh.passengerCapacity) {
          throw new DomainError('CAPACITY_EXCEEDED', `${onBoard} passengers between stop ${seg} and ${seg + 1}, but ${veh.identifier} has ${veh.passengerCapacity} passenger seats.`);
        }
      }
    }
  }
  const passengerIds = m.passengers.map((p) => p.workerId);
  if (passengerIds.length) {
    const found = await tx.select({ id: workers.id }).from(workers).where(inArray(workers.id, passengerIds));
    if (found.length !== passengerIds.length) throw new DomainError('VALIDATION_FAILED', 'A passenger was not found.');
  }
  const assignmentIds = m.passengers.map((p) => p.assignmentId).filter((x): x is string => !!x);
  if (assignmentIds.length) {
    const rows = await tx
      .select({ id: assignments.id, workerId: assignments.workerId, serviceDate: orderLines.serviceDate })
      .from(assignments)
      .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
      .where(inArray(assignments.id, assignmentIds));
    for (const p of m.passengers.filter((x) => x.assignmentId)) {
      const r = rows.find((x) => x.id === p.assignmentId);
      if (!r || r.workerId !== p.workerId) throw new DomainError('VALIDATION_FAILED', 'A passenger is linked to an assignment that is not theirs.');
      if (r.serviceDate !== trip.serviceDate) throw new DomainError('VALIDATION_FAILED', 'A passenger assignment is for a different date than this journey.');
    }
  }
  const [rev] = await tx
    .insert(tripRevisions)
    .values({
      organisationId: ctx.actor.organisationId,
      tripId: trip.id,
      revisionNo,
      driverId: m.driverId ?? null,
      vehicleId: m.vehicleId ?? null,
      plannedDepartureAt: m.plannedDepartureAt ? new Date(m.plannedDepartureAt) : null,
      estimatedEndAt: m.estimatedEndAt ? new Date(m.estimatedEndAt) : null,
      driverOwnAssignmentId: m.driverOwnAssignmentId ?? null,
      reason,
      createdBy: actorId(ctx.actor),
    })
    .returning();
  for (const [i, s] of m.stops.entries()) {
    await tx.insert(tripStops).values({
      organisationId: ctx.actor.organisationId,
      tripRevisionId: rev!.id,
      seq: i + 1,
      purpose: s.purpose,
      label: s.label,
      siteId: s.siteId ?? null,
      workLocationId: s.workLocationId ?? null,
      pickupPointId: s.pickupPointId ?? null,
      plannedAt: s.plannedAt ? new Date(s.plannedAt) : null,
      travelMinutesFromPrevious: s.travelMinutesFromPrevious ?? null,
    });
  }
  for (const p of m.passengers) {
    await tx.insert(tripPassengers).values({
      organisationId: ctx.actor.organisationId,
      tripRevisionId: rev!.id,
      workerId: p.workerId,
      assignmentId: p.assignmentId ?? null,
      boardStopSeq: p.boardStopSeq,
      alightStopSeq: p.alightStopSeq,
    });
  }
  // Driver and vehicle reservations for the journey window. Overlaps are rejected by the
  // database exclusion constraint, so a driver or vehicle cannot be double-booked.
  await tx.update(resourceReservations).set({ active: false }).where(and(eq(resourceReservations.tripId, trip.id), eq(resourceReservations.active, true)));
  if (rev!.plannedDepartureAt && rev!.estimatedEndAt) {
    if (rev!.estimatedEndAt <= rev!.plannedDepartureAt) throw new DomainError('VALIDATION_FAILED', 'The journey must end after it departs.');
    const during = tstzrange(rev!.plannedDepartureAt, rev!.estimatedEndAt);
    try {
      if (rev!.driverId) await tx.insert(resourceReservations).values({ organisationId: ctx.actor.organisationId, resourceType: 'driver', resourceId: rev!.driverId, during, tripId: trip.id });
      if (rev!.vehicleId) await tx.insert(resourceReservations).values({ organisationId: ctx.actor.organisationId, resourceType: 'vehicle', resourceId: rev!.vehicleId, during, tripId: trip.id });
    } catch (e) {
      translateDbError(e);
    }
  }
  return rev!;
}

async function currentRevision(tx: Tx, trip: TripRow): Promise<RevisionRow> {
  const [rev] = await tx.select().from(tripRevisions).where(and(eq(tripRevisions.tripId, trip.id), eq(tripRevisions.revisionNo, trip.currentRevision)));
  return rev!;
}

export async function createTrip(ctx: ServiceContext, raw: CreateTripInput, idempotencyKey?: string): Promise<{ id: string; reference: string; version: number }> {
  const input = createTripSchema.parse(raw);
  requireCapability(ctx.actor, 'trip.plan', input.branchId);
  return command(ctx, { operation: 'trip.create', idempotencyKey, input }, async (tx) => {
    const reference = await nextReference(tx, ctx, 'trip', 'TRP');
    const [trip] = await tx
      .insert(trips)
      .values({
        organisationId: ctx.actor.organisationId,
        branchId: input.branchId,
        serviceDate: input.serviceDate,
        legType: input.legType,
        reference,
        ownerMembershipId: actorId(ctx.actor),
        state: 'draft',
        currentRevision: 1,
        createdBy: actorId(ctx.actor),
      })
      .returning();
    const { branchId: _b, serviceDate: _d, legType: _l, ...manifest } = input;
    await writeRevision(tx, ctx, trip!, 1, manifest, 'Journey drafted');
    await audit(tx, ctx, { action: 'trip.created', entityType: 'trip', entityId: trip!.id, after: { reference, legType: input.legType, serviceDate: input.serviceDate } });
    return { id: trip!.id, reference, version: 1 };
  });
}

/**
 * Change route, manifest, driver or vehicle. Creates a new immutable revision; any earlier
 * driver acceptance no longer applies, and unsent manifests for the old revision are superseded.
 */
export async function reviseTrip(ctx: ServiceContext, tripId: string, raw: ReviseTripInput, idempotencyKey?: string): Promise<{ revisionNo: number; version: number; state: string }> {
  const input = reviseTripSchema.parse(raw);
  return command(ctx, { operation: 'trip.revise', idempotencyKey, input: { tripId, ...input } }, async (tx) => {
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).for('update');
    if (!trip) throw notFound('Journey');
    requireCapability(ctx.actor, 'trip.plan', trip.branchId);
    checkVersion(trip.version, input.expectedVersion);
    if (['cancelled', 'completed'].includes(trip.state)) throw new DomainError('INVALID_STATE', `This journey is ${trip.state}.`);
    const prev = await currentRevision(tx, trip);
    const revisionNo = trip.currentRevision + 1;
    const { expectedVersion: _v, reason, ...manifest } = input;
    await writeRevision(tx, ctx, trip, revisionNo, manifest, reason);
    const state = trip.state === 'draft' ? 'draft' : trip.state === 'departed' || trip.state === 'disrupted' ? trip.state : 'proposed';
    await tx.update(trips).set({ currentRevision: revisionNo, state, version: trip.version + 1, updatedAt: nowOf(ctx), updatedBy: actorId(ctx.actor) }).where(eq(trips.id, trip.id));
    await tx
      .update(messageDrafts)
      .set({ state: 'superseded', endedAt: nowOf(ctx), endReason: `Journey revision ${revisionNo}`, version: sql`${messageDrafts.version} + 1` })
      .where(and(eq(messageDrafts.entityType, 'trip'), eq(messageDrafts.entityId, trip.id), inArray(messageDrafts.state, ['draft', 'copied', 'queued'])));
    if (state === 'proposed' || state === 'departed' || state === 'disrupted') {
      const driverName = await driverDisplayName(tx, manifest.driverId ?? null);
      await closeTasksByKey(tx, ctx, `trip_call:${trip.id}`, `Superseded by revision ${revisionNo}`, 'cancelled');
      await createTask(tx, ctx, {
        branchId: trip.branchId,
        type: 'confirm_driver',
        title: driverName ? `Call ${driverName} to confirm revised journey ${trip.reference} (revision ${revisionNo})` : `Name a driver for journey ${trip.reference}`,
        entityType: 'trip',
        entityId: trip.id,
        ownerMembershipId: trip.ownerMembershipId,
        priority: 'high',
        dedupeKey: `trip_call:${trip.id}`,
      });
      const sent = await tx
        .select({ id: messageDrafts.id })
        .from(messageDrafts)
        .where(and(eq(messageDrafts.entityType, 'trip'), eq(messageDrafts.entityId, trip.id), inArray(messageDrafts.state, ['manually_marked_sent', 'provider_accepted', 'delivered', 'delivery_unknown', 'acknowledged'])));
      if (sent.length) {
        await createTask(tx, ctx, {
          branchId: trip.branchId,
          type: 'send_amendment',
          title: `Send the updated manifest for ${trip.reference}: the driver has an older version`,
          entityType: 'trip',
          entityId: trip.id,
          ownerMembershipId: trip.ownerMembershipId,
          priority: 'high',
          dedupeKey: `trip_amend:${trip.id}:${revisionNo}`,
        });
      }
    }
    await audit(tx, ctx, { action: 'trip.revised', entityType: 'trip', entityId: trip.id, before: { revisionNo: prev.revisionNo, driverId: prev.driverId }, after: { revisionNo, driverId: manifest.driverId ?? null }, reason });
    return { revisionNo, version: trip.version + 1, state };
  });
}

/** Read the current revision back as a manifest input (for incremental edits). */
async function manifestOf(tx: Tx, rev: RevisionRow): Promise<TripManifest> {
  const stops = await tx.select().from(tripStops).where(eq(tripStops.tripRevisionId, rev.id)).orderBy(asc(tripStops.seq));
  const ps = await tx.select().from(tripPassengers).where(eq(tripPassengers.tripRevisionId, rev.id));
  return {
    driverId: rev.driverId,
    vehicleId: rev.vehicleId,
    plannedDepartureAt: rev.plannedDepartureAt?.toISOString() ?? null,
    estimatedEndAt: rev.estimatedEndAt?.toISOString() ?? null,
    driverOwnAssignmentId: rev.driverOwnAssignmentId,
    stops: stops.map((s) => ({
      purpose: s.purpose as 'pickup' | 'dropoff' | 'driver_own_work',
      label: s.label,
      siteId: s.siteId,
      workLocationId: s.workLocationId,
      pickupPointId: s.pickupPointId,
      plannedAt: s.plannedAt?.toISOString() ?? null,
      travelMinutesFromPrevious: s.travelMinutesFromPrevious,
    })),
    passengers: ps.map((p) => ({ workerId: p.workerId, assignmentId: p.assignmentId, boardStopSeq: p.boardStopSeq, alightStopSeq: p.alightStopSeq })),
  };
}

/**
 * Add one passenger to the current manifest as a new revision. No expected version is needed:
 * the trip row is locked and capacity is re-checked, so concurrent additions are serialised
 * and the one that would overfill the vehicle receives CAPACITY_EXCEEDED.
 */
export async function addTripPassenger(
  ctx: ServiceContext,
  tripId: string,
  p: { workerId: string; assignmentId?: string | null; boardStopSeq: number; alightStopSeq: number },
): Promise<{ revisionNo: number; version: number }> {
  return command(ctx, { operation: 'trip.add_passenger' }, async (tx) => {
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).for('update');
    if (!trip) throw notFound('Journey');
    requireCapability(ctx.actor, 'trip.plan', trip.branchId);
    if (['cancelled', 'completed', 'departed'].includes(trip.state)) throw new DomainError('INVALID_STATE', `This journey is ${trip.state}.`);
    const rev = await currentRevision(tx, trip);
    const manifest = await manifestOf(tx, rev);
    manifest.passengers.push({ workerId: p.workerId, assignmentId: p.assignmentId ?? null, boardStopSeq: p.boardStopSeq, alightStopSeq: p.alightStopSeq });
    const revisionNo = trip.currentRevision + 1;
    await writeRevision(tx, ctx, trip, revisionNo, manifest, 'Passenger added');
    const state = trip.state === 'draft' ? 'draft' : 'proposed';
    await tx.update(trips).set({ currentRevision: revisionNo, state, version: trip.version + 1, updatedAt: nowOf(ctx) }).where(eq(trips.id, trip.id));
    if (state === 'proposed') {
      const name = await driverDisplayName(tx, rev.driverId);
      await closeTasksByKey(tx, ctx, `trip_call:${trip.id}`, `Superseded by revision ${revisionNo}`, 'cancelled');
      await createTask(tx, ctx, {
        branchId: trip.branchId,
        type: 'confirm_driver',
        title: `Call ${name ?? 'the driver'} to confirm the added passenger on ${trip.reference} (revision ${revisionNo})`,
        entityType: 'trip',
        entityId: trip.id,
        ownerMembershipId: trip.ownerMembershipId,
        priority: 'high',
        dedupeKey: `trip_call:${trip.id}`,
      });
    }
    await audit(tx, ctx, { action: 'trip.passenger_added', entityType: 'trip', entityId: trip.id, after: { revisionNo, workerId: p.workerId } });
    return { revisionNo, version: trip.version + 1 };
  });
}

async function driverDisplayName(tx: Tx, driverId: string | null): Promise<string | null> {
  if (!driverId) return null;
  const [d] = await tx.select({ name: drivers.displayName }).from(drivers).where(eq(drivers.id, driverId));
  return d?.name ?? null;
}

// ------------------------------------------------------------------ validation

export async function validateTripRevision(tx: Tx, trip: TripRow, rev: RevisionRow): Promise<TripViolation[]> {
  const v: TripViolation[] = [];
  const err = (code: string, message: string, subject?: string) => v.push({ code, severity: 'error', message, subject });
  const warn = (code: string, message: string, subject?: string) => v.push({ code, severity: 'warning', message, subject });
  const policy = await loadPolicy(tx, trip.branchId);

  const stops = await tx.select().from(tripStops).where(eq(tripStops.tripRevisionId, rev.id)).orderBy(asc(tripStops.seq));
  const passengers = await tx
    .select({ p: tripPassengers, name: workers.displayName })
    .from(tripPassengers)
    .innerJoin(workers, eq(workers.id, tripPassengers.workerId))
    .where(eq(tripPassengers.tripRevisionId, rev.id));

  // Driver: explicit, willing and not blocked.
  let driver: typeof drivers.$inferSelect | undefined;
  if (!rev.driverId) err('DRIVER_MISSING', 'No driver is named.');
  else {
    [driver] = await tx.select().from(drivers).where(eq(drivers.id, rev.driverId));
    if (!driver || driver.status !== 'active') err('DRIVER_UNAVAILABLE', 'The named driver is not active.');
    else {
      if (!driver.willingToDrive) err('DRIVER_NOT_WILLING', `${driver.displayName} has not agreed to drive.`);
      if (['blocked', 'expired'].includes(driver.readinessStatus)) err('DRIVER_NOT_READY', `${driver.displayName}'s driving checks are ${driver.readinessStatus}.`);
      else if (driver.readinessStatus !== 'cleared') warn('DRIVER_CHECKS_UNKNOWN', `${driver.displayName}'s driving checks are ${driver.readinessStatus}.`);
    }
  }

  // Vehicle and capacity per segment.
  let capacity: number | null = null;
  if (!rev.vehicleId) err('VEHICLE_MISSING', 'No vehicle is named.');
  else {
    const [veh] = await tx.select().from(vehicles).where(eq(vehicles.id, rev.vehicleId));
    capacity = veh?.passengerCapacity ?? null;
    if (capacity === null) err('CAPACITY_UNKNOWN', `Passenger capacity of ${veh?.identifier ?? 'the vehicle'} is not confirmed.`);
  }
  if (capacity !== null) {
    for (let seg = 1; seg < stops.length; seg++) {
      const onBoard = passengers.filter(({ p }) => p.boardStopSeq <= seg && p.alightStopSeq > seg).length;
      if (onBoard > capacity) err('CAPACITY_EXCEEDED', `${onBoard} passengers between stop ${seg} and ${seg + 1}, but only ${capacity} passenger seats.`, `segment:${seg}`);
    }
  }

  // Private travel parties: if any occupant belongs to a party that allows no extra passengers,
  // every other occupant must belong to that party.
  const occupantIds = passengers.map(({ p }) => p.workerId);
  if (driver?.workerId) occupantIds.push(driver.workerId);
  if (occupantIds.length > 1) {
    const memberships = await tx
      .select({ partyId: travelPartyMembers.partyId, workerId: travelPartyMembers.workerId, name: travelParties.name, allowed: travelParties.additionalPassengersAllowed, from: travelParties.validFrom, to: travelParties.validTo })
      .from(travelPartyMembers)
      .innerJoin(travelParties, eq(travelParties.id, travelPartyMembers.partyId))
      .where(inArray(travelPartyMembers.workerId, occupantIds));
    const privateParties = memberships.filter((m) => !m.allowed && (!m.from || m.from <= trip.serviceDate) && (!m.to || m.to >= trip.serviceDate));
    for (const partyId of new Set(privateParties.map((m) => m.partyId))) {
      const members = new Set(memberships.filter((m) => m.partyId === partyId).map((m) => m.workerId));
      const outsiders = occupantIds.filter((id) => !members.has(id));
      if (outsiders.length) {
        const name = privateParties.find((m) => m.partyId === partyId)!.name;
        err('PRIVATE_PARTY_CONFLICT', `${name} travel privately with no additional passengers; ${outsiders.length} other person(s) are on this journey.`, `party:${partyId}`);
      }
    }
  }

  // Times: each stop's ETA is its planned time, or departure plus entered travel estimates.
  const eta: (Date | null)[] = [];
  let running = rev.plannedDepartureAt;
  for (const s of stops) {
    if (s.plannedAt) running = s.plannedAt;
    else if (running && s.travelMinutesFromPrevious !== null) running = new Date(running.getTime() + s.travelMinutesFromPrevious * 60_000);
    else if (s.seq > 1) running = null;
    eta.push(running);
  }
  if (!rev.plannedDepartureAt) err('TIMES_MISSING', 'No planned departure time.');
  if (!rev.estimatedEndAt) err('TIMES_MISSING', 'No estimated end time, so the driver and vehicle cannot be reserved.');

  // Destinations must be verified, usable locations.
  const locIds = stops.filter((s) => s.purpose !== 'pickup' || trip.legType === 'return').map((s) => s.workLocationId).filter((x): x is string => !!x);
  const locs = locIds.length ? await tx.select().from(workLocations).where(inArray(workLocations.id, locIds)) : [];
  for (const s of stops) {
    const isSiteStop = trip.legType === 'return' ? s.purpose === 'pickup' : s.purpose !== 'pickup';
    if (!isSiteStop) continue;
    const loc = locs.find((l) => l.id === s.workLocationId);
    if (!loc) err('SITE_UNVERIFIED', `Stop ${s.seq} (${s.label}) has no work location with a verified entrance.`, `stop:${s.seq}`);
    else if (!loc.verifiedAt) err('SITE_UNVERIFIED', `The entrance for stop ${s.seq} (${loc.name}) has not been verified.`, `stop:${s.seq}`);
  }

  // Passengers' shifts: arrival deadlines (outbound), confirmation state, other journeys.
  const assignmentIds = passengers.map(({ p }) => p.assignmentId).filter((x): x is string => !!x);
  if (rev.driverOwnAssignmentId) assignmentIds.push(rev.driverOwnAssignmentId);
  const shiftRows = assignmentIds.length
    ? await tx
        .select({ id: assignments.id, state: assignments.state, arrivalAt: orderLines.arrivalAt, startAt: orderLines.startAt, endUnknown: orderLines.endUnknown })
        .from(assignments)
        .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
        .where(inArray(assignments.id, assignmentIds))
    : [];
  const bufferMs = policy.arrivalBufferMinutes * 60_000;
  for (const { p, name } of passengers) {
    const shift = shiftRows.find((s) => s.id === p.assignmentId);
    if (!p.assignmentId || !shift) {
      warn('PASSENGER_UNLINKED', `${name} is not linked to a shift assignment.`, `worker:${p.workerId}`);
      continue;
    }
    if (!['accepted', 'arrived'].includes(shift.state)) warn('PASSENGER_NOT_CONFIRMED', `${name} has not confirmed the shift (${shift.state}).`, `worker:${p.workerId}`);
    if (trip.legType === 'outbound') {
      const due = shift.arrivalAt ?? shift.startAt;
      const at = eta[p.alightStopSeq - 1];
      if (due && at && at.getTime() > due.getTime() - bufferMs) {
        err('LATE_ARRIVAL', `${name} would arrive ${formatInstantLocal(at)}, needed by ${formatInstantLocal(new Date(due.getTime() - bufferMs))}.`, `worker:${p.workerId}`);
      }
      if (due && !at) err('TIMES_MISSING', `No arrival estimate for ${name}'s drop-off.`, `worker:${p.workerId}`);
    }
    if (trip.legType === 'return' && shift.endUnknown) warn('FINISH_UNKNOWN', `${name}'s finish time is not known; confirm the pickup time.`, `worker:${p.workerId}`);
  }
  if (rev.driverOwnAssignmentId) {
    const own = shiftRows.find((s) => s.id === rev.driverOwnAssignmentId);
    const stop = stops.find((s) => s.purpose === 'driver_own_work');
    const due = own?.arrivalAt ?? own?.startAt;
    const at = stop ? eta[stop.seq - 1] : null;
    if (due && at && at.getTime() > due.getTime() - bufferMs) err('LATE_ARRIVAL', `The driver would reach their own shift at ${formatInstantLocal(at)}, needed by ${formatInstantLocal(new Date(due.getTime() - bufferMs))}.`, 'driver');
  }

  // A worker cannot be on two live journeys of the same kind that day.
  if (passengers.length) {
    const others = await tx
      .select({ workerId: tripPassengers.workerId, reference: trips.reference })
      .from(tripPassengers)
      .innerJoin(tripRevisions, eq(tripRevisions.id, tripPassengers.tripRevisionId))
      .innerJoin(trips, and(eq(trips.id, tripRevisions.tripId), eq(trips.currentRevision, tripRevisions.revisionNo)))
      .where(
        and(
          inArray(tripPassengers.workerId, passengers.map(({ p }) => p.workerId)),
          ne(trips.id, trip.id),
          eq(trips.serviceDate, trip.serviceDate),
          eq(trips.legType, trip.legType),
          sql`${trips.state} not in ('cancelled','completed')`,
        ),
      );
    for (const o of others) {
      const name = passengers.find(({ p }) => p.workerId === o.workerId)!.name;
      err('RESOURCE_CONFLICT', `${name} is also on journey ${o.reference}.`, `worker:${o.workerId}`);
    }
  }

  // A driver who is also a worker cannot be working somewhere else during the journey.
  if (driver?.workerId && rev.plannedDepartureAt && rev.estimatedEndAt) {
    const clash = await tx
      .select({ id: resourceReservations.id, assignmentId: resourceReservations.assignmentId })
      .from(resourceReservations)
      .where(
        and(
          eq(resourceReservations.resourceType, 'worker'),
          eq(resourceReservations.resourceId, driver.workerId),
          eq(resourceReservations.active, true),
          sql`${resourceReservations.during} && ${tstzrange(rev.plannedDepartureAt, rev.estimatedEndAt)}::tstzrange`,
        ),
      );
    for (const c of clash) {
      if (c.assignmentId && c.assignmentId === rev.driverOwnAssignmentId) continue;
      err('RESOURCE_CONFLICT', `${driver.displayName} is booked to work elsewhere during this journey.`, 'driver');
    }
  }
  if (passengers.length === 0 && trip.legType !== 'repositioning') warn('NO_PASSENGERS', 'No passengers on this journey.');
  return v;
}

export async function validateTrip(ctx: ServiceContext, tripId: string): Promise<{ revisionNo: number; violations: TripViolation[] }> {
  requireCapability(ctx.actor, 'trip.read');
  return read(ctx, async (tx) => {
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId));
    if (!trip) throw notFound('Journey');
    const rev = await currentRevision(tx, trip);
    return { revisionNo: rev.revisionNo, violations: await validateTripRevision(tx, trip, rev) };
  });
}

// ------------------------------------------------------------------ driver acceptance and publish

/** Mark the journey as proposed to the driver and create the "call the driver" task. */
export async function proposeTripToDriver(ctx: ServiceContext, tripId: string, expectedVersion: number): Promise<{ version: number }> {
  return command(ctx, { operation: 'trip.propose' }, async (tx) => {
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).for('update');
    if (!trip) throw notFound('Journey');
    requireCapability(ctx.actor, 'trip.plan', trip.branchId);
    checkVersion(trip.version, expectedVersion);
    if (trip.state !== 'draft') throw new DomainError('INVALID_STATE', `This journey is ${trip.state}.`);
    const rev = await currentRevision(tx, trip);
    if (!rev.driverId) throw new DomainError('VALIDATION_FAILED', 'Name a driver before proposing the journey.');
    const name = await driverDisplayName(tx, rev.driverId);
    await tx.update(trips).set({ state: 'proposed', version: trip.version + 1, updatedAt: nowOf(ctx) }).where(eq(trips.id, trip.id));
    await createTask(tx, ctx, {
      branchId: trip.branchId,
      type: 'confirm_driver',
      title: `Call ${name} to confirm the passengers and route for ${trip.reference} (revision ${rev.revisionNo})`,
      entityType: 'trip',
      entityId: trip.id,
      ownerMembershipId: trip.ownerMembershipId,
      priority: 'high',
      dedupeKey: `trip_call:${trip.id}`,
    });
    await audit(tx, ctx, { action: 'trip.proposed', entityType: 'trip', entityId: trip.id, after: { revisionNo: rev.revisionNo } });
    return { version: trip.version + 1 };
  });
}

/**
 * Record the named driver's answer for a specific revision (phone call, message or link).
 * An answer about an older revision is kept but does not count.
 */
export async function recordTripAcceptance(ctx: ServiceContext, tripId: string, raw: TripAcceptanceInput, idempotencyKey?: string): Promise<{ outcome: 'applied' | 'stale'; state: string; version: number }> {
  const input = tripAcceptanceSchema.parse(raw);
  return command(ctx, { operation: 'trip.acceptance', idempotencyKey, input: { tripId, ...input } }, async (tx) => {
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).for('update');
    if (!trip) throw notFound('Journey');
    requireCapability(ctx.actor, 'trip.record_acceptance', trip.branchId);
    const rev = await currentRevision(tx, trip);
    const [answered] = await tx.select().from(tripRevisions).where(and(eq(tripRevisions.tripId, trip.id), eq(tripRevisions.revisionNo, input.revisionNo)));
    if (!answered) throw new DomainError('VALIDATION_FAILED', 'That journey revision does not exist.');
    if (!answered.driverId) throw new DomainError('VALIDATION_FAILED', 'That revision has no named driver.');
    await tx.insert(tripAcceptances).values({
      organisationId: ctx.actor.organisationId,
      tripId: trip.id,
      tripRevisionNo: input.revisionNo,
      driverId: answered.driverId,
      decision: input.decision,
      method: input.method,
      recordedBy: actorId(ctx.actor)!,
      decidedAt: new Date(input.decidedAt),
      note: input.note ?? null,
    });
    if (input.revisionNo !== rev.revisionNo) {
      await audit(tx, ctx, { action: 'trip.acceptance_stale', entityType: 'trip', entityId: trip.id, after: { answeredRevision: input.revisionNo, currentRevision: rev.revisionNo } });
      return { outcome: 'stale' as const, state: trip.state, version: trip.version };
    }
    if (!['proposed', 'draft', 'driver_accepted'].includes(trip.state)) throw new DomainError('INVALID_STATE', `This journey is ${trip.state}.`);
    const state = input.decision === 'accepted' ? 'driver_accepted' : 'proposed';
    await tx.update(trips).set({ state, version: trip.version + 1, updatedAt: nowOf(ctx) }).where(eq(trips.id, trip.id));
    if (input.decision === 'accepted') {
      await closeTasksByKey(tx, ctx, `trip_call:${trip.id}`, `Driver accepted revision ${rev.revisionNo} by ${input.method}`);
    } else {
      await closeTasksByKey(tx, ctx, `trip_call:${trip.id}`, `Driver declined revision ${rev.revisionNo}`, 'cancelled');
      await createTask(tx, ctx, {
        branchId: trip.branchId,
        type: 'replan_trip',
        title: `Driver declined journey ${trip.reference}: find another driver or arrangement`,
        entityType: 'trip',
        entityId: trip.id,
        ownerMembershipId: trip.ownerMembershipId,
        priority: 'urgent',
        dedupeKey: `trip_replan:${trip.id}`,
      });
    }
    await audit(tx, ctx, { action: 'trip.acceptance_recorded', entityType: 'trip', entityId: trip.id, after: { revisionNo: rev.revisionNo, decision: input.decision, method: input.method } });
    return { outcome: 'applied' as const, state, version: trip.version + 1 };
  });
}

/** Publish a journey: only a valid revision the named driver has accepted. */
export async function publishTrip(ctx: ServiceContext, tripId: string, expectedVersion: number, idempotencyKey?: string): Promise<{ version: number; revisionNo: number }> {
  return command(ctx, { operation: 'trip.publish', idempotencyKey, input: { tripId, expectedVersion } }, async (tx) => {
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).for('update');
    if (!trip) throw notFound('Journey');
    requireCapability(ctx.actor, 'trip.publish', trip.branchId);
    checkVersion(trip.version, expectedVersion);
    const rev = await currentRevision(tx, trip);
    const violations = (await validateTripRevision(tx, trip, rev)).filter((x) => x.severity === 'error');
    const [acceptance] = await tx
      .select()
      .from(tripAcceptances)
      .where(and(eq(tripAcceptances.tripId, trip.id), eq(tripAcceptances.tripRevisionNo, rev.revisionNo)))
      .orderBy(sql`${tripAcceptances.decidedAt} desc`)
      .limit(1);
    if (!acceptance || acceptance.decision !== 'accepted' || acceptance.driverId !== rev.driverId || trip.state !== 'driver_accepted') {
      violations.push({ code: 'STALE_CONFIRMATION', severity: 'error', message: `The driver has not accepted revision ${rev.revisionNo}.` });
    }
    if (violations.length) {
      const code = violations.some((x) => x.code === 'CAPACITY_EXCEEDED' || x.code === 'CAPACITY_UNKNOWN')
        ? 'CAPACITY_EXCEEDED'
        : violations.some((x) => x.code === 'PRIVATE_PARTY_CONFLICT')
          ? 'PRIVATE_PARTY_CONFLICT'
          : violations.some((x) => x.code === 'SITE_UNVERIFIED')
            ? 'SITE_UNVERIFIED'
            : violations.some((x) => x.code === 'STALE_CONFIRMATION')
              ? 'STALE_CONFIRMATION'
              : 'VALIDATION_FAILED';
      throw new DomainError(code, 'This journey cannot be published yet.', { violations: violations.map((x) => ({ code: x.code, message: x.message, subject: x.subject })) });
    }
    await tx.update(trips).set({ state: 'published', version: trip.version + 1, updatedAt: nowOf(ctx) }).where(eq(trips.id, trip.id));
    const leg = trip.legType === 'return' ? 'return' : trip.legType === 'outbound' ? 'outbound' : null;
    if (leg) {
      const ps = await tx.select({ assignmentId: tripPassengers.assignmentId }).from(tripPassengers).where(eq(tripPassengers.tripRevisionId, rev.id));
      // The driver's own shift is covered by the journey they drive.
      if (rev.driverOwnAssignmentId) ps.push({ assignmentId: rev.driverOwnAssignmentId });
      for (const p of ps) {
        if (!p.assignmentId) continue;
        await tx
          .insert(transportRequirements)
          .values({ organisationId: ctx.actor.organisationId, assignmentId: p.assignmentId, leg, mode: 'agency_trip', tripId: trip.id, createdBy: actorId(ctx.actor) })
          .onConflictDoUpdate({ target: [transportRequirements.assignmentId, transportRequirements.leg], set: { mode: 'agency_trip', tripId: trip.id, updatedAt: nowOf(ctx) } });
        await closeTasksByKey(tx, ctx, `return_pickup:${p.assignmentId}`, `Return journey ${trip.reference} published`);
      }
    }
    await audit(tx, ctx, { action: 'trip.published', entityType: 'trip', entityId: trip.id, after: { revisionNo: rev.revisionNo } });
    await enqueue(tx, ctx, { eventType: 'trip.published', entityType: 'trip', entityId: trip.id, entityRevision: rev.revisionNo });
    return { version: trip.version + 1, revisionNo: rev.revisionNo };
  });
}

export async function setTripProgress(ctx: ServiceContext, tripId: string, state: 'departed' | 'completed', expectedVersion: number): Promise<{ version: number }> {
  return command(ctx, { operation: 'trip.progress' }, async (tx) => {
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).for('update');
    if (!trip) throw notFound('Journey');
    requireCapability(ctx.actor, 'trip.plan', trip.branchId);
    checkVersion(trip.version, expectedVersion);
    const allowed = state === 'departed' ? ['published'] : ['departed', 'published', 'disrupted'];
    if (!allowed.includes(trip.state)) throw new DomainError('INVALID_STATE', `A ${trip.state} journey cannot be marked ${state}.`);
    await tx.update(trips).set({ state, version: trip.version + 1, updatedAt: nowOf(ctx) }).where(eq(trips.id, trip.id));
    if (state === 'completed') await tx.update(resourceReservations).set({ active: false }).where(and(eq(resourceReservations.tripId, trip.id), eq(resourceReservations.active, true)));
    await audit(tx, ctx, { action: `trip.${state}`, entityType: 'trip', entityId: trip.id });
    return { version: trip.version + 1 };
  });
}

// ------------------------------------------------------------------ disruption and returns

/**
 * Breakdown, driver cancellation or similar: every passenger on the current manifest is
 * affected. Opens a case and concrete tasks (replacement transport, client ETA updates).
 */
export async function reportTripDisruption(ctx: ServiceContext, tripId: string, input: { kind: 'breakdown' | 'driver_cancelled' | 'delay' | 'other'; note: string }): Promise<{ caseId: string; affectedPassengers: number }> {
  return command(ctx, { operation: 'trip.disruption' }, async (tx) => {
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).for('update');
    if (!trip) throw notFound('Journey');
    requireCapability(ctx.actor, 'trip.plan', trip.branchId);
    if (['cancelled', 'completed'].includes(trip.state)) throw new DomainError('INVALID_STATE', `This journey is ${trip.state}.`);
    const rev = await currentRevision(tx, trip);
    const passengers = await tx
      .select({ workerId: tripPassengers.workerId, assignmentId: tripPassengers.assignmentId, name: workers.displayName, orderId: assignments.orderId })
      .from(tripPassengers)
      .innerJoin(workers, eq(workers.id, tripPassengers.workerId))
      .leftJoin(assignments, eq(assignments.id, tripPassengers.assignmentId))
      .where(eq(tripPassengers.tripRevisionId, rev.id));
    await tx.update(trips).set({ state: 'disrupted', version: trip.version + 1, updatedAt: nowOf(ctx) }).where(eq(trips.id, trip.id));
    const [c] = await tx
      .insert(cases)
      .values({
        organisationId: ctx.actor.organisationId,
        branchId: trip.branchId,
        type: input.kind === 'breakdown' ? 'breakdown' : 'transport_disruption',
        severity: 'high',
        ownerMembershipId: trip.ownerMembershipId,
        summary: `${trip.reference}: ${input.kind.replace('_', ' ')}. ${passengers.length} passenger(s) affected.`,
        affected: { tripId: trip.id, revisionNo: rev.revisionNo, passengers: passengers.map((p) => ({ workerId: p.workerId, assignmentId: p.assignmentId })) } as never,
        restrictedNotes: input.note,
        createdBy: actorId(ctx.actor),
      })
      .returning({ id: cases.id });
    await createTask(tx, ctx, {
      branchId: trip.branchId,
      type: 'replacement_transport',
      title: `Arrange replacement transport for ${passengers.length} passenger(s) on ${trip.reference}: ${passengers.map((p) => p.name).join(', ')}`,
      entityType: 'case',
      entityId: c!.id,
      ownerMembershipId: trip.ownerMembershipId,
      priority: 'urgent',
      dedupeKey: `replacement:${trip.id}:${rev.revisionNo}`,
    });
    const orderIds = [...new Set(passengers.map((p) => p.orderId).filter((x): x is string => !!x))];
    if (orderIds.length) {
      const os = await tx.select({ id: orders.id, reference: orders.reference, owner: orders.ownerMembershipId }).from(orders).where(inArray(orders.id, orderIds));
      for (const o of os) {
        await createTask(tx, ctx, {
          branchId: trip.branchId,
          type: 'client_eta_update',
          title: `Tell the client for ${o.reference} about the delay and give a new ETA`,
          entityType: 'order',
          entityId: o.id,
          ownerMembershipId: o.owner,
          priority: 'urgent',
          dedupeKey: `eta:${o.id}:${trip.id}`,
        });
      }
    }
    await audit(tx, ctx, { action: 'trip.disrupted', entityType: 'trip', entityId: trip.id, after: { kind: input.kind, caseId: c!.id, passengers: passengers.length } });
    return { caseId: c!.id, affectedPassengers: passengers.length };
  });
}

/**
 * Set how one leg of an assignment is covered. "Unresolved, dispatcher assigned" (unknown
 * finish, arranged later) is distinct from a booked journey; only a published trip sets agency_trip.
 */
export async function setTransportRequirement(ctx: ServiceContext, assignmentId: string, raw: TransportRequirementInput): Promise<void> {
  const input = transportRequirementSchema.parse(raw);
  if (input.mode === 'agency_trip') throw new DomainError('VALIDATION_FAILED', 'Agency transport is set by publishing a journey that includes this person.');
  if (input.mode === 'private_confirmed' && !input.arrangementNote?.trim()) {
    throw new DomainError('VALIDATION_FAILED', 'Record who confirmed the private arrangement and how.', { fieldErrors: { arrangementNote: ['Required.'] } });
  }
  await command(ctx, { operation: 'transport.requirement' }, async (tx) => {
    const [a] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
    if (!a) throw notFound('Assignment');
    requireCapability(ctx.actor, 'trip.plan', a.branchId);
    await tx
      .insert(transportRequirements)
      .values({
        organisationId: ctx.actor.organisationId,
        assignmentId,
        leg: input.leg,
        mode: input.mode,
        accountableMembershipId: input.accountableMembershipId ?? null,
        arrangementNote: input.arrangementNote ?? null,
        rawLabel: a.rawTransportLabel,
        createdBy: actorId(ctx.actor),
      })
      .onConflictDoUpdate({
        target: [transportRequirements.assignmentId, transportRequirements.leg],
        set: { mode: input.mode, accountableMembershipId: input.accountableMembershipId ?? null, arrangementNote: input.arrangementNote ?? null, tripId: null, updatedAt: nowOf(ctx), updatedBy: actorId(ctx.actor) },
      });
    await audit(tx, ctx, { action: 'transport.requirement_set', entityType: 'assignment', entityId: assignmentId, after: input });
  });
}

/**
 * A client or worker asks for a pickup now (variable finish, illness). Creates an urgent,
 * owned dispatch task; the return stays open until a journey is published or it is resolved.
 */
export async function requestReturnPickup(
  ctx: ServiceContext,
  input: { assignmentIds: string[]; pickupAt: Date; reason: 'finished' | 'unwell' | 'other'; restrictedNote?: string | null },
): Promise<{ taskIds: string[]; caseId: string | null }> {
  return command(ctx, { operation: 'transport.return_request' }, async (tx) => {
    const rows = await tx
      .select({ a: assignments, name: workers.displayName })
      .from(assignments)
      .innerJoin(workers, eq(workers.id, assignments.workerId))
      .where(inArray(assignments.id, input.assignmentIds));
    if (rows.length !== input.assignmentIds.length) throw notFound('Assignment');
    const branchId = rows[0]!.a.branchId;
    for (const r of rows) requireCapability(ctx.actor, 'trip.plan', r.a.branchId);
    let caseId: string | null = null;
    if (input.reason === 'unwell') {
      const [c] = await tx
        .insert(cases)
        .values({
          organisationId: ctx.actor.organisationId,
          branchId,
          type: 'welfare_pickup',
          severity: 'high',
          summary: `Immediate pickup needed for ${rows.map((r) => r.name).join(', ')}`,
          affected: rows.map((r) => ({ assignmentId: r.a.id, workerId: r.a.workerId })) as never,
          // Health details stay in restricted notes, never in task titles or messages.
          restrictedNotes: input.restrictedNote ?? null,
          ownerMembershipId: actorId(ctx.actor),
          createdBy: actorId(ctx.actor),
        })
        .returning({ id: cases.id });
      caseId = c!.id;
    }
    const taskIds: string[] = [];
    for (const r of rows) {
      await tx
        .insert(transportRequirements)
        .values({ organisationId: ctx.actor.organisationId, assignmentId: r.a.id, leg: 'return', mode: 'unresolved', accountableMembershipId: actorId(ctx.actor), arrangementNote: `Pickup requested for ${formatInstantLocal(input.pickupAt)}`, createdBy: actorId(ctx.actor) })
        .onConflictDoUpdate({
          target: [transportRequirements.assignmentId, transportRequirements.leg],
          set: { mode: 'unresolved', tripId: null, accountableMembershipId: actorId(ctx.actor), arrangementNote: `Pickup requested for ${formatInstantLocal(input.pickupAt)}`, updatedAt: nowOf(ctx) },
        });
      taskIds.push(
        await createTask(tx, ctx, {
          branchId,
          type: 'return_pickup',
          title: `${input.reason === 'unwell' ? 'Immediate pickup' : 'Return pickup'} for ${r.name} at ${formatInstantLocal(input.pickupAt)}: book a journey and confirm with the driver`,
          entityType: 'assignment',
          entityId: r.a.id,
          ownerMembershipId: actorId(ctx.actor),
          priority: 'urgent',
          dueAt: new Date(Math.min(input.pickupAt.getTime(), nowOf(ctx).getTime() + 15 * 60_000)),
          dedupeKey: `return_pickup:${r.a.id}`,
        }),
      );
    }
    await audit(tx, ctx, { action: 'transport.return_requested', entityType: 'assignment', entityId: rows[0]!.a.id, after: { assignmentIds: input.assignmentIds, pickupAt: input.pickupAt, reason: input.reason } });
    return { taskIds, caseId };
  });
}

export async function listDrivers(ctx: ServiceContext, branchId: string) {
  requireCapability(ctx.actor, 'trip.read', branchId);
  return read(ctx, (tx) => tx.select().from(drivers).where(and(eq(drivers.branchId, branchId), eq(drivers.status, 'active'))).orderBy(asc(drivers.displayName)));
}

/**
 * Cancel a journey. Reservations are released and every passenger's leg on this journey
 * becomes unresolved again, with a task to re-plan. A journey already on the road needs a
 * dispatcher decision instead.
 */
export async function cancelTrip(ctx: ServiceContext, tripId: string, input: { expectedVersion: number; reason: string }): Promise<{ affectedPassengers: number }> {
  return command(ctx, { operation: 'trip.cancel' }, async (tx) => {
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).for('update');
    if (!trip) throw notFound('Journey');
    requireCapability(ctx.actor, 'trip.plan', trip.branchId);
    checkVersion(trip.version, input.expectedVersion);
    if (trip.state === 'departed') throw new DomainError('INVALID_STATE', 'This journey is travelling: record a disruption and decide what happens to the passengers.');
    if (['cancelled', 'completed'].includes(trip.state)) throw new DomainError('INVALID_STATE', `This journey is ${trip.state}.`);
    await tx.update(trips).set({ state: 'cancelled', version: trip.version + 1, updatedAt: nowOf(ctx) }).where(eq(trips.id, trip.id));
    await tx.update(resourceReservations).set({ active: false }).where(and(eq(resourceReservations.tripId, trip.id), eq(resourceReservations.active, true)));
    await tx
      .update(messageDrafts)
      .set({ state: 'withdrawn', endedAt: nowOf(ctx), endReason: `Journey cancelled: ${input.reason}`, version: sql`${messageDrafts.version} + 1` })
      .where(and(eq(messageDrafts.entityType, 'trip'), eq(messageDrafts.entityId, trip.id), inArray(messageDrafts.state, ['draft', 'copied', 'queued'])));
    const affected = await tx
      .update(transportRequirements)
      .set({ mode: 'unresolved', tripId: null, arrangementNote: `Journey ${trip.reference} cancelled: ${input.reason}`, updatedAt: nowOf(ctx) })
      .where(eq(transportRequirements.tripId, trip.id))
      .returning({ assignmentId: transportRequirements.assignmentId });
    await closeTasksByKey(tx, ctx, `trip_call:${trip.id}`, 'Journey cancelled', 'cancelled');
    if (affected.length) {
      await createTask(tx, ctx, {
        branchId: trip.branchId,
        type: 'replan_transport',
        title: `Journey ${trip.reference} cancelled: arrange transport for ${affected.length} passenger(s) and tell them`,
        entityType: 'trip',
        entityId: trip.id,
        ownerMembershipId: trip.ownerMembershipId,
        priority: 'urgent',
        dedupeKey: `trip_cancel:${trip.id}`,
      });
    }
    await audit(tx, ctx, { action: 'trip.cancelled', entityType: 'trip', entityId: trip.id, reason: input.reason });
    return { affectedPassengers: affected.length };
  });
}
