import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { requireCapability, visibleBranchIds } from '@cds/auth';
import {
  assignments,
  branchMemberships,
  branches,
  clients,
  contactPoints,
  drivers,
  externalWorkerIds,
  handoverSnapshots,
  integrationSettings,
  memberships,
  messageDrafts,
  orderLines,
  orders,
  sites,
  tasks,
  transportRequirements,
  tripAcceptances,
  tripPassengers,
  tripRevisions,
  tripStops,
  trips,
  vehicles,
  workLocations,
  workerAliases,
  workerSkills,
  workers,
} from '@cds/db';
import { notFound, read, type ServiceContext } from './context';
import { evaluateReadiness, describeIssues } from './readiness';
import { validateTripRevision } from './transport';

/** Branches, clients, sites, locations, staff, drivers and vehicles visible to the actor. */
export async function referenceData(ctx: ServiceContext) {
  return read(ctx, async (tx) => {
    const bs = await tx
      .select()
      .from(branches)
      .where(inArray(branches.id, visibleBranchIds(ctx.actor).length ? visibleBranchIds(ctx.actor) : ['00000000-0000-0000-0000-000000000000']))
      .orderBy(asc(branches.name));
    const cs = await tx.select().from(clients).where(eq(clients.status, 'active')).orderBy(asc(clients.displayName));
    const ss = await tx.select().from(sites).where(eq(sites.active, true)).orderBy(asc(sites.canonicalName));
    const ls = await tx.select().from(workLocations).orderBy(asc(workLocations.name));
    const staff = await tx
      .selectDistinct({ id: memberships.id, name: memberships.displayName, branchId: branchMemberships.branchId })
      .from(memberships)
      .innerJoin(branchMemberships, eq(branchMemberships.membershipId, memberships.id))
      .where(eq(memberships.status, 'active'))
      .orderBy(asc(memberships.displayName));
    const ds = await tx.select().from(drivers).where(eq(drivers.status, 'active')).orderBy(asc(drivers.displayName));
    const vs = await tx.select().from(vehicles).where(eq(vehicles.status, 'active')).orderBy(asc(vehicles.identifier));
    return { branches: bs, clients: cs, sites: ss, locations: ls, staff, drivers: ds, vehicles: vs };
  });
}

export async function listTrips(ctx: ServiceContext, q: { branchId: string; date: string }) {
  requireCapability(ctx.actor, 'trip.read', q.branchId);
  return read(ctx, async (tx) => {
    const rows = await tx
      .select({
        t: trips,
        driverName: drivers.displayName,
        vehicle: vehicles.identifier,
        capacity: vehicles.passengerCapacity,
        revId: tripRevisions.id,
        departure: tripRevisions.plannedDepartureAt,
      })
      .from(trips)
      .innerJoin(tripRevisions, and(eq(tripRevisions.tripId, trips.id), eq(tripRevisions.revisionNo, trips.currentRevision)))
      .leftJoin(drivers, eq(drivers.id, tripRevisions.driverId))
      .leftJoin(vehicles, eq(vehicles.id, tripRevisions.vehicleId))
      .where(and(eq(trips.branchId, q.branchId), eq(trips.serviceDate, q.date)))
      .orderBy(asc(trips.legType), asc(tripRevisions.plannedDepartureAt));
    const counts = rows.length
      ? await tx
          .select({ rev: tripPassengers.tripRevisionId, n: sql<number>`count(*)::int` })
          .from(tripPassengers)
          .where(
            inArray(
              tripPassengers.tripRevisionId,
              rows.map((r) => r.revId),
            ),
          )
          .groupBy(tripPassengers.tripRevisionId)
      : [];
    return rows.map((r) => ({ ...r, passengers: counts.find((c) => c.rev === r.revId)?.n ?? 0 }));
  });
}

/** Confirmed people for a date and how each leg is covered. Unassigned legs are never hidden. */
export async function transportNeeds(ctx: ServiceContext, q: { branchId: string; date: string }) {
  requireCapability(ctx.actor, 'trip.read', q.branchId);
  return read(ctx, async (tx) => {
    const rows = await tx
      .select({
        assignmentId: assignments.id,
        workerId: workers.id,
        workerName: workers.displayName,
        reference: orders.reference,
        lineNo: orderLines.lineNo,
        siteName: sites.canonicalName,
        arrivalAt: orderLines.arrivalAt,
        endAt: orderLines.endAt,
        state: assignments.state,
        rawLabel: assignments.rawTransportLabel,
      })
      .from(assignments)
      .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .innerJoin(workers, eq(workers.id, assignments.workerId))
      .leftJoin(sites, eq(sites.id, orderLines.siteId))
      .where(
        and(
          eq(orderLines.branchId, q.branchId),
          eq(orderLines.serviceDate, q.date),
          inArray(assignments.state, ['accepted', 'reconfirmation_required', 'arrived']),
        ),
      )
      .orderBy(asc(orderLines.arrivalAt), asc(workers.displayName));
    const reqs = rows.length
      ? await tx
          .select({ r: transportRequirements, tripRef: trips.reference, tripState: trips.state, accountable: memberships.displayName })
          .from(transportRequirements)
          .leftJoin(trips, eq(trips.id, transportRequirements.tripId))
          .leftJoin(memberships, eq(memberships.id, transportRequirements.accountableMembershipId))
          .where(
            inArray(
              transportRequirements.assignmentId,
              rows.map((r) => r.assignmentId),
            ),
          )
      : [];
    return rows.map((r) => ({
      ...r,
      outbound: reqs.find((x) => x.r.assignmentId === r.assignmentId && x.r.leg === 'outbound') ?? null,
      return: reqs.find((x) => x.r.assignmentId === r.assignmentId && x.r.leg === 'return') ?? null,
    }));
  });
}

export async function getTripDetail(ctx: ServiceContext, tripId: string) {
  requireCapability(ctx.actor, 'trip.read');
  return read(ctx, async (tx) => {
    const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId));
    if (!trip) throw notFound('Journey');
    const revisions = await tx.select().from(tripRevisions).where(eq(tripRevisions.tripId, trip.id)).orderBy(desc(tripRevisions.revisionNo));
    const rev = revisions.find((r) => r.revisionNo === trip.currentRevision)!;
    const [driver] = rev.driverId ? await tx.select().from(drivers).where(eq(drivers.id, rev.driverId)) : [];
    const [vehicle] = rev.vehicleId ? await tx.select().from(vehicles).where(eq(vehicles.id, rev.vehicleId)) : [];
    const stops = await tx
      .select({ s: tripStops, loc: workLocations })
      .from(tripStops)
      .leftJoin(workLocations, eq(workLocations.id, tripStops.workLocationId))
      .where(eq(tripStops.tripRevisionId, rev.id))
      .orderBy(asc(tripStops.seq));
    const passengers = await tx
      .select({ p: tripPassengers, name: workers.displayName })
      .from(tripPassengers)
      .innerJoin(workers, eq(workers.id, tripPassengers.workerId))
      .where(eq(tripPassengers.tripRevisionId, rev.id))
      .orderBy(asc(tripPassengers.boardStopSeq), asc(workers.displayName));
    let running = rev.plannedDepartureAt;
    const stopRows = stops.map(({ s, loc }) => {
      if (s.plannedAt) running = s.plannedAt;
      else if (running && s.travelMinutesFromPrevious !== null) running = new Date(running.getTime() + s.travelMinutesFromPrevious * 60_000);
      else if (s.seq > 1) running = null;
      const onBoardAfter = passengers.filter(({ p }) => p.boardStopSeq <= s.seq && p.alightStopSeq > s.seq).length;
      return { ...s, eta: running, location: loc, onBoardAfter };
    });
    const acceptances = await tx.select().from(tripAcceptances).where(eq(tripAcceptances.tripId, trip.id)).orderBy(desc(tripAcceptances.createdAt));
    const violations = await validateTripRevision(tx, trip, rev);
    const drafts = await tx
      .select()
      .from(messageDrafts)
      .where(and(eq(messageDrafts.entityType, 'trip'), eq(messageDrafts.entityId, trip.id)))
      .orderBy(desc(messageDrafts.createdAt));
    const onTrip = new Set(passengers.map(({ p }) => p.workerId));
    const available = (
      await tx
        .select({ assignmentId: assignments.id, workerId: workers.id, name: workers.displayName, reference: orders.reference })
        .from(assignments)
        .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
        .innerJoin(orders, eq(orders.id, assignments.orderId))
        .innerJoin(workers, eq(workers.id, assignments.workerId))
        .where(
          and(
            eq(orderLines.serviceDate, trip.serviceDate),
            eq(orderLines.branchId, trip.branchId),
            inArray(assignments.state, ['accepted', 'reconfirmation_required']),
          ),
        )
        .orderBy(asc(workers.displayName))
    ).filter((a) => !onTrip.has(a.workerId));
    return {
      trip,
      revision: rev,
      revisions,
      driver: driver ?? null,
      vehicle: vehicle ?? null,
      stops: stopRows,
      passengers,
      acceptances,
      violations,
      drafts,
      available,
    };
  });
}

export async function searchWorkers(ctx: ServiceContext, q: string) {
  requireCapability(ctx.actor, 'worker.read');
  return read(ctx, async (tx) => {
    const term = q.trim();
    const rows = await tx
      .select()
      .from(workers)
      .where(
        term
          ? or(
              ilike(workers.displayName, `%${term}%`),
              sql`exists (select 1 from app.external_worker_ids e where e.worker_id = ${workers.id} and e.external_id = ${term})`,
              sql`exists (select 1 from app.worker_aliases a where a.worker_id = ${workers.id} and a.alias ilike ${'%' + term + '%'})`,
            )
          : undefined,
      )
      .orderBy(asc(workers.displayName))
      .limit(100);
    const ids = rows.map((r) => r.id);
    if (!ids.length) return [];
    const ext = await tx.select().from(externalWorkerIds).where(inArray(externalWorkerIds.workerId, ids));
    const aliases = await tx.select().from(workerAliases).where(inArray(workerAliases.workerId, ids));
    const skills = await tx.select().from(workerSkills).where(inArray(workerSkills.workerId, ids));
    const drv = await tx.select().from(drivers).where(inArray(drivers.workerId, ids));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
    const anyClient = (await tx.select({ id: clients.id }).from(clients).limit(1))[0]?.id;
    const readiness = anyClient ? await evaluateReadiness(tx, { workerIds: ids, siteId: null, clientId: anyClient, date: today }) : new Map();
    const upcoming = await tx
      .select({ workerId: assignments.workerId, state: assignments.state, date: orderLines.serviceDate, reference: orders.reference, orderId: orders.id })
      .from(assignments)
      .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .where(
        and(
          inArray(assignments.workerId, ids),
          sql`${orderLines.serviceDate} >= ${today}`,
          inArray(assignments.state, ['proposed', 'offered', 'accepted', 'reconfirmation_required']),
        ),
      )
      .orderBy(asc(orderLines.serviceDate));
    return rows.map((w) => ({
      worker: w,
      externalIds: ext.filter((e) => e.workerId === w.id),
      aliases: aliases.filter((a) => a.workerId === w.id),
      skills: skills.filter((s) => s.workerId === w.id),
      isDriver: drv.some((d) => d.workerId === w.id && d.willingToDrive),
      readinessBlocking: readiness.get(w.id)?.blocking.length ? describeIssues(readiness.get(w.id)!.blocking) : null,
      upcoming: upcoming.filter((u) => u.workerId === w.id),
    }));
  });
}

export async function getDraft(ctx: ServiceContext, id: string) {
  requireCapability(ctx.actor, 'message.draft');
  return read(ctx, async (tx) => {
    const [d] = await tx.select().from(messageDrafts).where(eq(messageDrafts.id, id));
    if (!d) throw notFound('Message');
    const name = d.recipientWorkerId
      ? (await tx.select({ n: workers.displayName }).from(workers).where(eq(workers.id, d.recipientWorkerId)))[0]?.n
      : d.recipientDriverId
        ? (await tx.select({ n: drivers.displayName }).from(drivers).where(eq(drivers.id, d.recipientDriverId)))[0]?.n
        : null;
    const [contact] = d.contactPointId ? await tx.select().from(contactPoints).where(eq(contactPoints.id, d.contactPointId)) : [];
    return { draft: d, recipientName: name ?? 'Unknown', contactStillCurrent: !!contact && contact.status === 'active' && contact.value === d.contactValue };
  });
}

export async function listHandovers(ctx: ServiceContext, branchId: string) {
  requireCapability(ctx.actor, 'handover.manage', branchId);
  return read(ctx, async (tx) => {
    const rows = await tx.select().from(handoverSnapshots).where(eq(handoverSnapshots.branchId, branchId)).orderBy(desc(handoverSnapshots.asOf)).limit(30);
    const ids = [...new Set(rows.flatMap((r) => [r.outgoingMembershipId, r.incomingMembershipId]))];
    const names = ids.length
      ? await tx.select({ id: memberships.id, name: memberships.displayName }).from(memberships).where(inArray(memberships.id, ids))
      : [];
    return rows.map((r) => ({
      ...r,
      outgoingName: names.find((n) => n.id === r.outgoingMembershipId)?.name,
      incomingName: names.find((n) => n.id === r.incomingMembershipId)?.name,
    }));
  });
}

export async function myOpenTasks(ctx: ServiceContext, branchId: string) {
  return read(ctx, async (tx) => {
    return tx
      .select({ t: tasks, ownerName: memberships.displayName })
      .from(tasks)
      .leftJoin(memberships, eq(memberships.id, tasks.ownerMembershipId))
      .where(and(or(eq(tasks.branchId, branchId), isNull(tasks.branchId)), inArray(tasks.state, ['open', 'in_progress'])))
      .orderBy(desc(sql`${tasks.priority} = 'urgent'`), asc(tasks.dueAt), asc(tasks.createdAt));
  });
}

export async function integrationStatus(ctx: ServiceContext) {
  return read(ctx, (tx) => tx.select().from(integrationSettings));
}
