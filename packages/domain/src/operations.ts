import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { addDays, type StaffingState, type TransportState } from '@cds/contracts';
import { requireCapability } from '@cds/auth';
import {
  assignmentResponses,
  assignments,
  clients,
  externalBookings,
  memberships,
  messageDrafts,
  orderConflicts,
  orderLines,
  orderRevisions,
  orderSourceLinks,
  orders,
  sites,
  sourceMessages,
  tasks,
  transportRequirements,
  trips,
  workLocations,
  workers,
  type Tx,
} from '@cds/db';
import { notFound, read, type ServiceContext } from './context';
import { locationProblem } from './locations';
import { describeIssues, evaluateReadiness } from './readiness';

export type Blocker = { code: string; message: string };

export type LineStatus = {
  lineId: string;
  requested: number;
  accepted: number | null;
  proposed: number;
  confirmed: number;
  reconfirmationRequired: number;
  arrived: number;
  clientShortfall: number;
  confirmationShortfall: number;
  staffing: StaffingState;
  transport: TransportState;
  transportUnresolvedLegs: number;
  externalPending: number;
  externalVerified: number;
  openConflicts: number;
  siteVerified: boolean;
  ready: boolean;
  blockers: Blocker[];
  summary: string;
};

/**
 * Computed dispatch readiness per line (build plan §6). Never cached: every call recomputes from
 * current facts, and each red requirement is listed individually so a green count cannot hide it.
 */
export async function lineStatuses(tx: Tx, lineIds: string[]): Promise<Map<string, LineStatus>> {
  const out = new Map<string, LineStatus>();
  if (!lineIds.length) return out;
  const lines = await tx
    .select({ l: orderLines, clientId: orders.clientId, requiresExternal: clients.requiresExternalBooking, loc: workLocations })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(clients, eq(clients.id, orders.clientId))
    .leftJoin(workLocations, eq(workLocations.id, orderLines.workLocationId))
    .where(inArray(orderLines.id, lineIds));
  const as = await tx
    .select({
      id: assignments.id,
      lineId: assignments.lineId,
      state: assignments.state,
      workerId: assignments.workerId,
      acceptedLineVersion: assignments.acceptedLineVersion,
      name: workers.displayName,
    })
    .from(assignments)
    .innerJoin(workers, eq(workers.id, assignments.workerId))
    .where(and(inArray(assignments.lineId, lineIds), inArray(assignments.state, ['proposed', 'offered', 'accepted', 'reconfirmation_required', 'arrived'])));
  const aIds = as.map((a) => a.id);
  const reqs = aIds.length
    ? await tx
        .select({
          assignmentId: transportRequirements.assignmentId,
          leg: transportRequirements.leg,
          mode: transportRequirements.mode,
          accountable: transportRequirements.accountableMembershipId,
          tripState: trips.state,
        })
        .from(transportRequirements)
        .leftJoin(trips, eq(trips.id, transportRequirements.tripId))
        .where(inArray(transportRequirements.assignmentId, aIds))
    : [];
  const ext = aIds.length ? await tx.select().from(externalBookings).where(inArray(externalBookings.assignmentId, aIds)) : [];
  const conflicts = await tx
    .select({ lineId: orderConflicts.lineId, orderId: orderConflicts.orderId, field: orderConflicts.fieldPath })
    .from(orderConflicts)
    .where(and(eq(orderConflicts.state, 'open'), inArray(orderConflicts.orderId, [...new Set(lines.map((x) => x.l.orderId))])));

  for (const { l, clientId, requiresExternal, loc } of lines) {
    const locProblem = locationProblem(loc, l.siteId, l.serviceDate);
    const mine = as.filter((a) => a.lineId === l.id);
    const confirmedA = mine.filter((a) => (a.state === 'accepted' && a.acceptedLineVersion === l.lineVersion) || a.state === 'arrived');
    const proposed = mine.filter((a) => a.state === 'proposed' || a.state === 'offered').length;
    const reconfirm = mine.filter((a) => a.state === 'reconfirmation_required').length;
    const arrived = mine.filter((a) => a.state === 'arrived').length;
    const accepted = l.acceptedCount;
    const confirmed = confirmedA.length;
    const blockers: Blocker[] = [];
    const lineConflicts = conflicts.filter((c) => c.orderId === l.orderId && (c.lineId === null || c.lineId === l.id));
    if (l.lineState === 'cancelled') blockers.push({ code: 'CANCELLED', message: 'Line cancelled.' });
    for (const c of lineConflicts) blockers.push({ code: 'SOURCE_CONFLICT', message: `Conflicting ${c.field} needs resolving.` });
    if (!l.siteId) blockers.push({ code: 'SITE_PENDING', message: 'Site not confirmed.' });
    else if (locProblem) blockers.push({ code: 'SITE_UNVERIFIED', message: `Site entrance: ${locProblem}` });
    if (!l.startAt) blockers.push({ code: 'START_UNRESOLVED', message: 'Start time not confirmed.' });
    if (accepted === null) blockers.push({ code: 'NOT_ACCEPTED', message: 'Agency has not decided how many it accepts.' });
    const confirmationShortfall = Math.max(0, (accepted ?? 0) - confirmed);
    if (accepted !== null && confirmationShortfall > 0)
      blockers.push({ code: 'UNCONFIRMED', message: `${confirmationShortfall} of ${accepted} not confirmed by workers.` });
    if (reconfirm) blockers.push({ code: 'RECONFIRM', message: `${reconfirm} worker(s) must reconfirm the changed shift.` });

    let unresolvedLegs = 0;
    let unconfirmedJourneys = 0;
    let anyAgency = false;
    let allReady = true;
    for (const a of confirmedA) {
      for (const leg of ['outbound', 'return'] as const) {
        const r = reqs.find((x) => x.assignmentId === a.id && x.leg === leg);
        if (!r || (r.mode === 'unresolved' && !(leg === 'return' && r.accountable))) {
          unresolvedLegs++;
          allReady = false;
        } else if (r.mode === 'agency_trip') {
          anyAgency = true;
          if (!['published', 'departed', 'completed'].includes(r.tripState ?? '')) {
            allReady = false;
            unconfirmedJourneys++;
          }
        } else if (r.mode === 'unresolved') allReady = false;
      }
    }
    if (unresolvedLegs) blockers.push({ code: 'TRANSPORT_UNRESOLVED', message: `${unresolvedLegs} transport leg(s) unresolved.` });
    if (unconfirmedJourneys)
      blockers.push({ code: 'JOURNEY_UNCONFIRMED', message: `${unconfirmedJourneys} leg(s) on a journey the driver has not accepted in its current form.` });
    const transport: TransportState = !confirmedA.length
      ? 'unplanned'
      : unresolvedLegs
        ? 'unplanned'
        : allReady
          ? anyAgency
            ? 'ready'
            : 'not_required'
          : 'proposed';

    const extMine = ext.filter((e) => confirmedA.some((a) => a.id === e.assignmentId));
    const externalVerified = extMine.filter((e) => e.state === 'verified' && e.lineVersion === l.lineVersion).length;
    const externalPending = requiresExternal ? confirmedA.length - externalVerified : 0;
    if (requiresExternal && externalPending > 0)
      blockers.push({ code: 'EXTERNAL_UNVERIFIED', message: `${externalPending} JoinedUp booking(s) not verified for the current version.` });

    if (confirmedA.length) {
      const rd = await evaluateReadiness(tx, { workerIds: confirmedA.map((a) => a.workerId), siteId: l.siteId, clientId, date: l.serviceDate });
      for (const a of confirmedA) {
        const r = rd.get(a.workerId)!;
        if (r.blocking.length) blockers.push({ code: 'READINESS_BLOCKED', message: `${a.name}: ${describeIssues(r.blocking)}.` });
      }
    }

    const active = mine.filter((a) => a.state !== 'arrived').length + arrived;
    const staffing: StaffingState =
      accepted !== null && active > accepted
        ? 'over_allocated'
        : accepted !== null && confirmed >= accepted && accepted > 0
          ? 'confirmed_full'
          : confirmed > 0
            ? 'partly_confirmed'
            : accepted !== null && active >= accepted && accepted > 0
              ? 'proposed_full'
              : active > 0
                ? 'partly_proposed'
                : 'unfilled';
    const parts = [`${l.requestedCount} requested`, `${accepted ?? '?'} accepted`, `${confirmed} confirmed`];
    if (proposed) parts.push(`${proposed} awaiting reply`);
    if (unresolvedLegs) parts.push(`${unresolvedLegs} transport leg(s) unresolved`);
    if (requiresExternal && externalPending) parts.push(`${externalPending} JoinedUp unverified`);
    out.set(l.id, {
      lineId: l.id,
      requested: l.requestedCount,
      accepted,
      proposed,
      confirmed,
      reconfirmationRequired: reconfirm,
      arrived,
      clientShortfall: Math.max(0, l.requestedCount - (accepted ?? 0)),
      confirmationShortfall,
      staffing,
      transport,
      transportUnresolvedLegs: unresolvedLegs,
      externalPending,
      externalVerified,
      openConflicts: lineConflicts.length,
      siteVerified: !locProblem,
      ready: blockers.length === 0,
      blockers,
      summary: parts.join('; '),
    });
  }
  return out;
}

export type BoardRow = {
  orderId: string;
  reference: string;
  lineId: string;
  lineNo: number;
  serviceDate: string;
  clientName: string;
  siteName: string | null;
  role: string | null;
  teamLabel: string | null;
  arrivalAt: Date | null;
  startAt: Date | null;
  requestState: string;
  urgency: string;
  ownerName: string | null;
  updatedAt: Date;
  status: LineStatus;
  nextAction: string;
};

/** The operations board for one branch and service date. */
export async function operationsBoard(ctx: ServiceContext, q: { branchId: string; date: string }) {
  requireCapability(ctx.actor, 'order.read', q.branchId);
  return read(ctx, async (tx) => {
    const rows = await tx
      .select({
        o: orders,
        l: orderLines,
        clientName: clients.displayName,
        siteName: sites.canonicalName,
        ownerName: memberships.displayName,
      })
      .from(orderLines)
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .innerJoin(clients, eq(clients.id, orders.clientId))
      .leftJoin(sites, eq(sites.id, orderLines.siteId))
      .leftJoin(memberships, eq(memberships.id, orders.ownerMembershipId))
      .where(
        and(
          eq(orderLines.branchId, q.branchId),
          eq(orderLines.serviceDate, q.date),
          eq(orderLines.lineState, 'open'),
          sql`${orders.requestState} not in ('cancelled','declined','closed')`,
        ),
      )
      .orderBy(asc(orderLines.arrivalAt), asc(orders.reference), asc(orderLines.lineNo));
    const statuses = await lineStatuses(
      tx,
      rows.map((r) => r.l.id),
    );
    const board: BoardRow[] = rows.map((r) => {
      const status = statuses.get(r.l.id)!;
      return {
        orderId: r.o.id,
        reference: r.o.reference,
        lineId: r.l.id,
        lineNo: r.l.lineNo,
        serviceDate: r.l.serviceDate,
        clientName: r.clientName,
        siteName: r.siteName,
        role: r.l.role,
        teamLabel: r.l.teamLabel,
        arrivalAt: r.l.arrivalAt,
        startAt: r.l.startAt,
        requestState: r.o.requestState,
        urgency: r.o.urgency,
        ownerName: r.ownerName,
        updatedAt: r.l.updatedAt > r.o.updatedAt ? r.l.updatedAt : r.o.updatedAt,
        status,
        nextAction: status.blockers[0]?.message ?? 'Ready',
      };
    });
    const openTasks = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        priority: tasks.priority,
        type: tasks.type,
        dueAt: tasks.dueAt,
        coverageAlert: tasks.coverageAlert,
        ownerName: memberships.displayName,
        entityType: tasks.entityType,
        entityId: tasks.entityId,
        version: tasks.version,
      })
      .from(tasks)
      .leftJoin(memberships, eq(memberships.id, tasks.ownerMembershipId))
      .where(and(or(eq(tasks.branchId, q.branchId), isNull(tasks.branchId)), inArray(tasks.state, ['open', 'in_progress'])))
      .orderBy(desc(sql`${tasks.priority} = 'urgent'`), asc(tasks.dueAt), asc(tasks.createdAt))
      .limit(200);
    const returnQueue = await tx
      .select({
        assignmentId: transportRequirements.assignmentId,
        workerName: workers.displayName,
        mode: transportRequirements.mode,
        note: transportRequirements.arrangementNote,
        accountable: memberships.displayName,
        reference: orders.reference,
      })
      .from(transportRequirements)
      .innerJoin(assignments, eq(assignments.id, transportRequirements.assignmentId))
      .innerJoin(orderLines, eq(orderLines.id, assignments.lineId))
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .innerJoin(workers, eq(workers.id, assignments.workerId))
      .leftJoin(memberships, eq(memberships.id, transportRequirements.accountableMembershipId))
      .where(
        and(
          eq(transportRequirements.leg, 'return'),
          eq(transportRequirements.mode, 'unresolved'),
          eq(orderLines.serviceDate, q.date),
          eq(orderLines.branchId, q.branchId),
          inArray(assignments.state, ['accepted', 'arrived', 'reconfirmation_required']),
        ),
      )
      .orderBy(asc(workers.displayName));
    const counts = {
      lines: board.length,
      requested: board.reduce((s, r) => s + r.status.requested, 0),
      accepted: board.reduce((s, r) => s + (r.status.accepted ?? 0), 0),
      confirmed: board.reduce((s, r) => s + r.status.confirmed, 0),
      arrived: board.reduce((s, r) => s + r.status.arrived, 0),
      uncoveredSlots: board.reduce((s, r) => s + r.status.confirmationShortfall, 0),
      unresolvedTransportLegs: board.reduce((s, r) => s + r.status.transportUnresolvedLegs, 0),
      unverifiedExternal: board.reduce((s, r) => s + r.status.externalPending, 0),
      openConflicts: board.reduce((s, r) => s + r.status.openConflicts, 0),
      urgentTasks: openTasks.filter((t) => t.priority === 'urgent').length,
      coverageAlerts: openTasks.filter((t) => t.coverageAlert).length,
      lateOrders: new Set(board.filter((r) => r.urgency !== 'normal').map((r) => r.orderId)).size,
    };
    return { date: q.date, generatedAt: new Date(), board, tasks: openTasks, returnQueue, counts };
  });
}

/** Everything about one order for its detail page. */
export async function getOrderDetail(ctx: ServiceContext, orderId: string) {
  requireCapability(ctx.actor, 'order.read');
  return read(ctx, async (tx) => {
    const [o] = await tx
      .select({ o: orders, clientName: clients.displayName, ownerName: memberships.displayName })
      .from(orders)
      .innerJoin(clients, eq(clients.id, orders.clientId))
      .leftJoin(memberships, eq(memberships.id, orders.ownerMembershipId))
      .where(eq(orders.id, orderId));
    if (!o) throw notFound('Order');
    const lines = await tx
      .select({ l: orderLines, siteName: sites.canonicalName, locationName: workLocations.name, locationVerified: workLocations.verifiedAt })
      .from(orderLines)
      .leftJoin(sites, eq(sites.id, orderLines.siteId))
      .leftJoin(workLocations, eq(workLocations.id, orderLines.workLocationId))
      .where(eq(orderLines.orderId, orderId))
      .orderBy(asc(orderLines.lineNo));
    const statuses = await lineStatuses(
      tx,
      lines.map((x) => x.l.id),
    );
    const as = await tx
      .select({ a: assignments, workerName: workers.displayName })
      .from(assignments)
      .innerJoin(workers, eq(workers.id, assignments.workerId))
      .where(eq(assignments.orderId, orderId))
      .orderBy(asc(workers.displayName));
    const aIds = as.map((x) => x.a.id);
    const reqs = aIds.length
      ? await tx
          .select({ r: transportRequirements, tripRef: trips.reference, tripState: trips.state })
          .from(transportRequirements)
          .leftJoin(trips, eq(trips.id, transportRequirements.tripId))
          .where(inArray(transportRequirements.assignmentId, aIds))
      : [];
    const ext = aIds.length ? await tx.select().from(externalBookings).where(inArray(externalBookings.assignmentId, aIds)) : [];
    const responses = aIds.length
      ? await tx.select().from(assignmentResponses).where(inArray(assignmentResponses.assignmentId, aIds)).orderBy(desc(assignmentResponses.createdAt))
      : [];
    const drafts = await tx
      .select()
      .from(messageDrafts)
      .where(
        and(
          eq(messageDrafts.entityType, 'order_line'),
          inArray(messageDrafts.entityId, lines.length ? lines.map((x) => x.l.id) : ['00000000-0000-0000-0000-000000000000']),
        ),
      )
      .orderBy(desc(messageDrafts.createdAt));
    const conflicts = await tx.select().from(orderConflicts).where(eq(orderConflicts.orderId, orderId)).orderBy(desc(orderConflicts.raisedAt));
    const revisions = await tx.select().from(orderRevisions).where(eq(orderRevisions.orderId, orderId)).orderBy(desc(orderRevisions.revisionNo));
    const sources = await tx
      .selectDistinct({ s: sourceMessages, relation: orderSourceLinks.relation, revisionNo: orderSourceLinks.revisionNo })
      .from(orderSourceLinks)
      .innerJoin(sourceMessages, eq(sourceMessages.id, orderSourceLinks.sourceMessageId))
      .where(eq(orderSourceLinks.orderId, orderId))
      .orderBy(asc(sourceMessages.receivedAt));
    const lineIds = lines.map((x) => x.l.id);
    const openTasks = await tx
      .select({ t: tasks, ownerName: memberships.displayName })
      .from(tasks)
      .leftJoin(memberships, eq(memberships.id, tasks.ownerMembershipId))
      .where(and(inArray(tasks.state, ['open', 'in_progress']), inArray(tasks.entityId, [orderId, ...lineIds, ...aIds, ...conflicts.map((c) => c.id)])))
      .orderBy(desc(sql`${tasks.priority} = 'urgent'`), asc(tasks.createdAt));
    return {
      order: o.o,
      clientName: o.clientName,
      ownerName: o.ownerName,
      lines: lines.map((x) => ({ ...x, status: statuses.get(x.l.id)! })),
      assignments: as.map((x) => ({
        ...x,
        transport: reqs.filter((r) => r.r.assignmentId === x.a.id),
        external: ext.find((e) => e.assignmentId === x.a.id) ?? null,
        responses: responses.filter((r) => r.assignmentId === x.a.id),
      })),
      drafts,
      conflicts,
      revisions,
      sources,
      tasks: openTasks,
    };
  });
}

/** Today/tomorrow helper in the business timezone. */
export function operationalDates(now: Date, zone = 'Europe/London'): { today: string; tomorrow: string } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return { today, tomorrow: addDays(today, 1) };
}
