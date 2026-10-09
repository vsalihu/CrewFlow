// Drizzle table definitions for the CDS Operations domain (build plan §16).
// This file is the source of truth for table shape; `drizzle-kit generate` produces
// the reviewed DDL migration. Constraints Drizzle cannot express (range exclusion,
// RLS policies, grants, security-definer helpers) live in hand-written SQL migrations.
//
// Conventions: UUID keys; every organisation-owned row has organisation_id and a
// UNIQUE (organisation_id, id) so children can use composite foreign keys that make
// cross-organisation references impossible at the database level.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const app = pgSchema('app');

const tstzrange = customType<{ data: string }>({
  dataType: () => 'tstzrange',
});

const ts = (name?: string) => (name ? timestamp(name, { withTimezone: true }) : timestamp({ withTimezone: true }));

const id = () => uuid().primaryKey().defaultRandom();
const orgId = () => uuid().notNull();
const audited = () => ({
  createdAt: ts().notNull().defaultNow(),
  createdBy: uuid(),
  updatedAt: ts().notNull().defaultNow(),
  updatedBy: uuid(),
  version: integer().notNull().default(1),
});

// ---------------------------------------------------------------- organisation

export const organisations = app.table('organisations', {
  id: id(),
  name: text().notNull(),
  defaultTimezone: text().notNull().default('Europe/London'),
  policyVersion: integer().notNull().default(1),
  /** Branch/client-overridable policy values (urgency thresholds, buffers). Documented in docs/decisions.md. */
  settings: jsonb().notNull().default({}),
  ...audited(),
});

export const branches = app.table(
  'branches',
  {
    id: id(),
    organisationId: orgId().references(() => organisations.id),
    name: text().notNull(),
    timezone: text().notNull().default('Europe/London'),
    settings: jsonb().notNull().default({}),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id)],
);

export const memberships = app.table(
  'memberships',
  {
    id: id(),
    organisationId: orgId().references(() => organisations.id),
    /** Supabase Auth user id (auth.users.id). Never trusted from the browser. */
    authUserId: uuid().notNull(),
    displayName: text().notNull(),
    email: text(),
    status: text().notNull().default('active'),
    /** Organisation-wide roles, e.g. org_admin. Branch roles live in branch_memberships. */
    roles: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id), unique().on(t.authUserId, t.organisationId)],
);

export const branchMemberships = app.table(
  'branch_memberships',
  {
    id: id(),
    organisationId: orgId(),
    membershipId: uuid().notNull(),
    branchId: uuid().notNull(),
    roles: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ...audited(),
  },
  (t) => [
    unique().on(t.membershipId, t.branchId),
    foreignKey({ columns: [t.organisationId, t.membershipId], foreignColumns: [memberships.organisationId, memberships.id] }),
    foreignKey({ columns: [t.organisationId, t.branchId], foreignColumns: [branches.organisationId, branches.id] }),
  ],
);

export const dutyPeriods = app.table(
  'duty_periods',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    membershipId: uuid().notNull(),
    backupMembershipId: uuid(),
    startsAt: ts().notNull(),
    endsAt: ts().notNull(),
    acknowledgedAt: ts(),
    ...audited(),
  },
  (t) => [
    foreignKey({ columns: [t.organisationId, t.branchId], foreignColumns: [branches.organisationId, branches.id] }),
    foreignKey({ columns: [t.organisationId, t.membershipId], foreignColumns: [memberships.organisationId, memberships.id] }),
    check('duty_period_order', sql`${t.endsAt} > ${t.startsAt}`),
    index().on(t.organisationId, t.branchId, t.startsAt),
  ],
);

// ---------------------------------------------------------------- clients and sites

export const clients = app.table(
  'clients',
  {
    id: id(),
    organisationId: orgId().references(() => organisations.id),
    legalName: text().notNull(),
    displayName: text().notNull(),
    status: text().notNull().default('active'),
    accountOwnerMembershipId: uuid(),
    /** Whether bookings for this client must be entered and verified in JoinedUp. */
    requiresExternalBooking: boolean().notNull().default(true),
    officialChannel: text(),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id)],
);

export const clientContacts = app.table(
  'client_contacts',
  {
    id: id(),
    organisationId: orgId(),
    clientId: uuid().notNull(),
    name: text().notNull(),
    roleTitle: text(),
    authorityScope: text(),
    allowedSiteIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: text().notNull().default('active'),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id), foreignKey({ columns: [t.organisationId, t.clientId], foreignColumns: [clients.organisationId, clients.id] })],
);

export const sites = app.table(
  'sites',
  {
    id: id(),
    organisationId: orgId(),
    clientId: uuid().notNull(),
    branchId: uuid().notNull(),
    canonicalName: text().notNull(),
    address: text(),
    postcode: text(),
    timezone: text().notNull().default('Europe/London'),
    active: boolean().notNull().default(true),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    foreignKey({ columns: [t.organisationId, t.clientId], foreignColumns: [clients.organisationId, clients.id] }),
    foreignKey({ columns: [t.organisationId, t.branchId], foreignColumns: [branches.organisationId, branches.id] }),
  ],
);

/** Field, entrance or yard — where people actually go. Unverified locations block dispatch. */
export const workLocations = app.table(
  'work_locations',
  {
    id: id(),
    organisationId: orgId(),
    siteId: uuid().notNull(),
    name: text().notNull(),
    pinText: text(),
    latitude: text(),
    longitude: text(),
    accessInstructions: text(),
    validFrom: date({ mode: 'string' }),
    validTo: date({ mode: 'string' }),
    verifiedAt: ts(),
    verifiedBy: uuid(),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id), foreignKey({ columns: [t.organisationId, t.siteId], foreignColumns: [sites.organisationId, sites.id] })],
);

export const siteAliases = app.table(
  'site_aliases',
  {
    id: id(),
    organisationId: orgId(),
    siteId: uuid().notNull(),
    alias: text().notNull(),
    source: text(),
    verifiedBy: uuid(),
    verifiedAt: ts(),
    ...audited(),
  },
  (t) => [foreignKey({ columns: [t.organisationId, t.siteId], foreignColumns: [sites.organisationId, sites.id] })],
);

// ---------------------------------------------------------------- readiness

export const readinessRequirements = app.table(
  'readiness_requirements',
  {
    id: id(),
    organisationId: orgId().references(() => organisations.id),
    /** worker | worker_site | site | client */
    scope: text().notNull(),
    requirementType: text().notNull(),
    label: text().notNull(),
    /** blocking | warning | not_required — set by an authorised policy owner, never inferred. */
    policy: text().notNull(),
    clientId: uuid(),
    siteId: uuid(),
    effectiveFrom: date({ mode: 'string' }),
    effectiveTo: date({ mode: 'string' }),
    approverCapability: text().notNull().default('readiness.approve'),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    check('readiness_policy_valid', sql`${t.policy} in ('blocking','warning','not_required')`),
    check('readiness_scope_valid', sql`${t.scope} in ('worker','worker_site','site','client')`),
  ],
);

export const readinessChecks = app.table(
  'readiness_checks',
  {
    id: id(),
    organisationId: orgId(),
    requirementId: uuid().notNull(),
    workerId: uuid(),
    siteId: uuid(),
    clientId: uuid(),
    status: text().notNull(),
    validFrom: date({ mode: 'string' }),
    validTo: date({ mode: 'string' }),
    checkedBy: uuid(),
    checkedAt: ts(),
    externalReference: text(),
    reason: text(),
    ...audited(),
  },
  (t) => [
    foreignKey({
      columns: [t.organisationId, t.requirementId],
      foreignColumns: [readinessRequirements.organisationId, readinessRequirements.id],
    }),
    check('readiness_status_valid', sql`${t.status} in ('unknown','pending','cleared','expired','blocked')`),
    index().on(t.organisationId, t.workerId),
  ],
);

// ---------------------------------------------------------------- workers

export const workers = app.table(
  'workers',
  {
    id: id(),
    organisationId: orgId().references(() => organisations.id),
    homeBranchId: uuid().notNull(),
    legalName: text().notNull(),
    displayName: text().notNull(),
    status: text().notNull().default('active'),
    /** Personal latest finish (e.g. must leave by 18:00). Local wall-clock time. */
    latestFinishLocal: time(),
    earliestStartLocal: time(),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    foreignKey({ columns: [t.organisationId, t.homeBranchId], foreignColumns: [branches.organisationId, branches.id] }),
    index('workers_display_name_trgm').using('gin', sql`${t.displayName} gin_trgm_ops`),
  ],
);

/** External IDs are strings: leading zeroes are significant and they are not phone numbers. */
export const externalWorkerIds = app.table(
  'external_worker_ids',
  {
    id: id(),
    organisationId: orgId(),
    workerId: uuid().notNull(),
    provider: text().notNull(),
    externalId: text().notNull(),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.provider, t.externalId),
    foreignKey({ columns: [t.organisationId, t.workerId], foreignColumns: [workers.organisationId, workers.id] }),
  ],
);

export const workerAliases = app.table(
  'worker_aliases',
  {
    id: id(),
    organisationId: orgId(),
    workerId: uuid().notNull(),
    alias: text().notNull(),
    /** alias | previous_name | original_spelling */
    kind: text().notNull().default('alias'),
    source: text(),
    verifiedBy: uuid(),
    verifiedAt: ts(),
    ...audited(),
  },
  (t) => [
    foreignKey({ columns: [t.organisationId, t.workerId], foreignColumns: [workers.organisationId, workers.id] }),
    index('worker_aliases_trgm').using('gin', sql`${t.alias} gin_trgm_ops`),
  ],
);

export const contactPoints = app.table(
  'contact_points',
  {
    id: id(),
    organisationId: orgId(),
    workerId: uuid(),
    clientContactId: uuid(),
    driverId: uuid(),
    /** phone | email | whatsapp */
    type: text().notNull(),
    value: text().notNull(),
    normalised: text().notNull(),
    /** unverified | active | superseded */
    status: text().notNull().default('unverified'),
    verifiedAt: ts(),
    verifiedBy: uuid(),
    supersedesId: uuid(),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id), index().on(t.organisationId, t.workerId)],
);

export const workerSkills = app.table(
  'worker_skills',
  {
    id: id(),
    organisationId: orgId(),
    workerId: uuid().notNull(),
    skill: text().notNull(),
    evidence: text(),
    expiresOn: date({ mode: 'string' }),
    reviewedBy: uuid(),
    ...audited(),
  },
  (t) => [
    foreignKey({ columns: [t.organisationId, t.workerId], foreignColumns: [workers.organisationId, workers.id] }),
    index().on(t.organisationId, t.workerId),
  ],
);

export const workerAvailability = app.table(
  'worker_availability',
  {
    id: id(),
    organisationId: orgId(),
    workerId: uuid().notNull(),
    during: tstzrange().notNull(),
    /** available | unavailable */
    kind: text().notNull(),
    source: text(),
    note: text(),
    ...audited(),
  },
  (t) => [
    foreignKey({ columns: [t.organisationId, t.workerId], foreignColumns: [workers.organisationId, workers.id] }),
    index().on(t.organisationId, t.workerId),
  ],
);

export const pickupPoints = app.table(
  'pickup_points',
  {
    id: id(),
    organisationId: orgId(),
    workerId: uuid(),
    label: text().notNull(),
    address: text(),
    postcode: text(),
    pinText: text(),
    landmark: text(),
    verifiedAt: ts(),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id)],
);

/** A private travel arrangement, e.g. a couple travelling together with no extra passengers. */
export const travelParties = app.table(
  'travel_parties',
  {
    id: id(),
    organisationId: orgId().references(() => organisations.id),
    name: text().notNull(),
    additionalPassengersAllowed: boolean().notNull(),
    validFrom: date({ mode: 'string' }),
    validTo: date({ mode: 'string' }),
    source: text(),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id)],
);

export const travelPartyMembers = app.table(
  'travel_party_members',
  {
    id: id(),
    organisationId: orgId(),
    partyId: uuid().notNull(),
    workerId: uuid().notNull(),
    constraintType: text().notNull().default('travel_together'),
    ...audited(),
  },
  (t) => [
    unique().on(t.partyId, t.workerId),
    foreignKey({ columns: [t.organisationId, t.partyId], foreignColumns: [travelParties.organisationId, travelParties.id] }),
    foreignKey({ columns: [t.organisationId, t.workerId], foreignColumns: [workers.organisationId, workers.id] }),
  ],
);

// ---------------------------------------------------------------- sources

export const conversations = app.table(
  'conversations',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    channel: text().notNull(),
    externalRef: text(),
    label: text().notNull(),
    clientId: uuid(),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id), foreignKey({ columns: [t.organisationId, t.branchId], foreignColumns: [branches.organisationId, branches.id] })],
);

/** Original evidence. Raw text is preserved exactly as received and never edited. */
export const sourceMessages = app.table(
  'source_messages',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    /** pasted_message | phone_note | email | portal | import */
    kind: text().notNull(),
    conversationId: uuid(),
    providerMessageId: text(),
    senderLabel: text(),
    clientContactId: uuid(),
    /** When the client sent it (or the call took place). */
    receivedAt: ts().notNull(),
    recordedBy: uuid().notNull(),
    rawText: text().notNull(),
    /** For phone notes: who called. A phone note is staff-recorded, not client-authored. */
    callerName: text(),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    unique('source_messages_provider_id').on(t.organisationId, t.conversationId, t.providerMessageId),
    foreignKey({ columns: [t.organisationId, t.branchId], foreignColumns: [branches.organisationId, branches.id] }),
    index().on(t.organisationId, t.branchId, t.receivedAt),
  ],
);

// ---------------------------------------------------------------- orders

export const orders = app.table(
  'orders',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    clientId: uuid().notNull(),
    clientContactId: uuid(),
    reference: text().notNull(),
    ownerMembershipId: uuid(),
    requestState: text().notNull().default('received'),
    sourceAuthority: text(),
    currentRevision: integer().notNull().default(1),
    receivedAt: ts().notNull(),
    urgency: text().notNull().default('normal'),
    acceptanceNote: text(),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    unique().on(t.organisationId, t.reference),
    foreignKey({ columns: [t.organisationId, t.branchId], foreignColumns: [branches.organisationId, branches.id] }),
    foreignKey({ columns: [t.organisationId, t.clientId], foreignColumns: [clients.organisationId, clients.id] }),
    index().on(t.organisationId, t.clientId, t.requestState),
  ],
);

/** An independently fulfilable shift line: one date, site, role and start. */
export const orderLines = app.table(
  'order_lines',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    orderId: uuid().notNull(),
    lineNo: integer().notNull(),
    serviceDate: date({ mode: 'string' }).notNull(),
    siteId: uuid(),
    workLocationId: uuid(),
    role: text(),
    requiredSkill: text(),
    teamLabel: text(),
    requestedCount: integer().notNull(),
    /** Agency-accepted quantity. Null until the agency decides. */
    acceptedCount: integer(),
    minimumCount: integer(),
    timezone: text().notNull().default('Europe/London'),
    arrivalLocal: time(),
    startLocal: time(),
    startWindowEndLocal: time(),
    endLocal: time(),
    endDayOffset: integer().notNull().default(0),
    endUnknown: boolean().notNull().default(true),
    arrivalAt: ts(),
    startAt: ts(),
    endAt: ts(),
    breakRule: text(),
    notes: text(),
    /** open | cancelled */
    lineState: text().notNull().default('open'),
    /** Material version of this line. Worker confirmations bind to it. */
    lineVersion: integer().notNull().default(1),
    replacementDeclinedAt: ts(),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    unique().on(t.orderId, t.lineNo),
    foreignKey({ columns: [t.organisationId, t.orderId], foreignColumns: [orders.organisationId, orders.id] }),
    foreignKey({ columns: [t.organisationId, t.siteId], foreignColumns: [sites.organisationId, sites.id] }),
    check('line_counts_nonnegative', sql`${t.requestedCount} >= 0 and coalesce(${t.acceptedCount},0) >= 0 and coalesce(${t.minimumCount},0) >= 0`),
    check('line_minimum_le_requested', sql`${t.minimumCount} is null or ${t.minimumCount} <= ${t.requestedCount}`),
    check('line_accepted_le_requested', sql`${t.acceptedCount} is null or ${t.acceptedCount} <= ${t.requestedCount}`),
    check('line_end_after_start', sql`${t.endAt} is null or ${t.startAt} is null or ${t.endAt} > ${t.startAt}`),
    check('line_arrival_before_start', sql`${t.arrivalAt} is null or ${t.startAt} is null or ${t.arrivalAt} <= ${t.startAt}`),
    index().on(t.organisationId, t.branchId, t.serviceDate),
  ],
);

/** Immutable revision snapshots. The runtime role has INSERT/SELECT only. */
export const orderRevisions = app.table(
  'order_revisions',
  {
    id: id(),
    organisationId: orgId(),
    orderId: uuid().notNull(),
    revisionNo: integer().notNull(),
    snapshot: jsonb().notNull(),
    changes: jsonb().notNull().default([]),
    reason: text().notNull(),
    actorId: uuid(),
    sourceMessageIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    effectiveAt: ts().notNull().defaultNow(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [unique().on(t.orderId, t.revisionNo), foreignKey({ columns: [t.organisationId, t.orderId], foreignColumns: [orders.organisationId, orders.id] })],
);

export const orderSourceLinks = app.table(
  'order_source_links',
  {
    id: id(),
    organisationId: orgId(),
    orderId: uuid().notNull(),
    lineId: uuid(),
    revisionNo: integer().notNull(),
    sourceMessageId: uuid().notNull(),
    relation: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
    createdBy: uuid(),
  },
  (t) => [
    foreignKey({ columns: [t.organisationId, t.orderId], foreignColumns: [orders.organisationId, orders.id] }),
    foreignKey({ columns: [t.organisationId, t.sourceMessageId], foreignColumns: [sourceMessages.organisationId, sourceMessages.id] }),
  ],
);

/** A visible disagreement between sources (e.g. 06:30 vs 07:00). Blocks dispatch until resolved. */
export const orderConflicts = app.table(
  'order_conflicts',
  {
    id: id(),
    organisationId: orgId(),
    orderId: uuid().notNull(),
    lineId: uuid(),
    fieldPath: text().notNull(),
    /** [{ value, sourceMessageId?, note? }] — every observed value is kept. */
    observations: jsonb().notNull(),
    state: text().notNull().default('open'),
    raisedBy: uuid(),
    raisedAt: ts().notNull().defaultNow(),
    resolvedValue: jsonb(),
    resolvedBy: uuid(),
    resolvedAt: ts(),
    resolutionNote: text(),
    ...audited(),
  },
  (t) => [
    foreignKey({ columns: [t.organisationId, t.orderId], foreignColumns: [orders.organisationId, orders.id] }),
    index().on(t.organisationId, t.orderId, t.state),
  ],
);

// ---------------------------------------------------------------- assignments

export const assignments = app.table(
  'assignments',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    orderId: uuid().notNull(),
    lineId: uuid().notNull(),
    workerId: uuid().notNull(),
    state: text().notNull().default('proposed'),
    /** Line version the current offer describes. */
    offeredLineVersion: integer().notNull(),
    /** Line version the worker actually accepted. Valid only if equal to current line version. */
    acceptedLineVersion: integer(),
    offerExpiresAt: ts(),
    proposedBy: uuid(),
    /** Raw transport label copied from a roster (e.g. "OWN"). Preserved, never interpreted. */
    rawTransportLabel: text(),
    endReason: text(),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    foreignKey({ columns: [t.organisationId, t.lineId], foreignColumns: [orderLines.organisationId, orderLines.id] }),
    foreignKey({ columns: [t.organisationId, t.workerId], foreignColumns: [workers.organisationId, workers.id] }),
    uniqueIndex('assignments_one_active_per_line_worker')
      .on(t.lineId, t.workerId)
      .where(sql`state in ('proposed','offered','accepted','reconfirmation_required','arrived')`),
    index().on(t.organisationId, t.workerId, t.state),
  ],
);

/** Every worker response is retained as evidence, including stale and blocked ones. */
export const assignmentResponses = app.table(
  'assignment_responses',
  {
    id: id(),
    organisationId: orgId(),
    assignmentId: uuid().notNull(),
    lineVersion: integer().notNull(),
    response: text().notNull(),
    channel: text().notNull(),
    respondedAt: ts().notNull(),
    recordedBy: uuid().notNull(),
    evidenceNote: text(),
    /** applied | stale | blocked_readiness | ambiguous */
    outcome: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [foreignKey({ columns: [t.organisationId, t.assignmentId], foreignColumns: [assignments.organisationId, assignments.id] })],
);

/**
 * Time reservations for workers, drivers and vehicles. A range-exclusion constraint
 * (SQL migration 0001) makes overlapping active reservations for one resource impossible,
 * so two coordinators cannot commit incompatible bookings concurrently.
 */
export const resourceReservations = app.table(
  'resource_reservations',
  {
    id: id(),
    organisationId: orgId(),
    resourceType: text().notNull(),
    resourceId: uuid().notNull(),
    during: tstzrange().notNull(),
    assignmentId: uuid(),
    tripId: uuid(),
    active: boolean().notNull().default(true),
    uncertain: boolean().notNull().default(false),
    ...audited(),
  },
  (t) => [
    check('reservation_resource_type', sql`${t.resourceType} in ('worker','driver','vehicle')`),
    index().on(t.organisationId, t.assignmentId),
    index().on(t.organisationId, t.tripId),
  ],
);

// ---------------------------------------------------------------- transport

/** Driving capability is an explicit record. It is never inferred from a roster label. */
export const drivers = app.table(
  'drivers',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    workerId: uuid(),
    membershipId: uuid(),
    displayName: text().notNull(),
    willingToDrive: boolean().notNull(),
    /** Summary of authorised licence/insurance checks under business policy. */
    readinessStatus: text().notNull().default('unknown'),
    readinessReference: text(),
    readinessCheckedBy: uuid(),
    readinessCheckedAt: ts(),
    status: text().notNull().default('active'),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    foreignKey({ columns: [t.organisationId, t.branchId], foreignColumns: [branches.organisationId, branches.id] }),
    foreignKey({ columns: [t.organisationId, t.workerId], foreignColumns: [workers.organisationId, workers.id] }),
  ],
);

export const vehicles = app.table(
  'vehicles',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    identifier: text().notNull(),
    registration: text(),
    operator: text(),
    totalSeats: integer(),
    /** Passenger seats excluding the driver. Null = unknown, which blocks publication. */
    passengerCapacity: integer(),
    /** Default driver for a private vehicle, if any. Does not grant permission to carry passengers. */
    ownerDriverId: uuid(),
    readinessStatus: text().notNull().default('unknown'),
    status: text().notNull().default('active'),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    foreignKey({ columns: [t.organisationId, t.branchId], foreignColumns: [branches.organisationId, branches.id] }),
    check('vehicle_capacity_nonnegative', sql`${t.passengerCapacity} is null or ${t.passengerCapacity} >= 0`),
  ],
);

export const trips = app.table(
  'trips',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    serviceDate: date({ mode: 'string' }).notNull(),
    legType: text().notNull(),
    reference: text().notNull(),
    ownerMembershipId: uuid(),
    state: text().notNull().default('draft'),
    currentRevision: integer().notNull().default(1),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    unique().on(t.organisationId, t.reference),
    foreignKey({ columns: [t.organisationId, t.branchId], foreignColumns: [branches.organisationId, branches.id] }),
    index().on(t.organisationId, t.branchId, t.serviceDate, t.state),
  ],
);

/** Immutable route + manifest. Acceptance binds to a revision; any material change creates a new one. */
export const tripRevisions = app.table(
  'trip_revisions',
  {
    id: id(),
    organisationId: orgId(),
    tripId: uuid().notNull(),
    revisionNo: integer().notNull(),
    driverId: uuid(),
    vehicleId: uuid(),
    plannedDepartureAt: ts(),
    latestArrivalAt: ts(),
    estimatedEndAt: ts(),
    /** The driver's own work assignment, when the driver also works at a destination. */
    driverOwnAssignmentId: uuid(),
    reason: text().notNull(),
    createdBy: uuid(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    unique().on(t.tripId, t.revisionNo),
    foreignKey({ columns: [t.organisationId, t.tripId], foreignColumns: [trips.organisationId, trips.id] }),
    foreignKey({ columns: [t.organisationId, t.driverId], foreignColumns: [drivers.organisationId, drivers.id] }),
    foreignKey({ columns: [t.organisationId, t.vehicleId], foreignColumns: [vehicles.organisationId, vehicles.id] }),
  ],
);

export const tripStops = app.table(
  'trip_stops',
  {
    id: id(),
    organisationId: orgId(),
    tripRevisionId: uuid().notNull(),
    seq: integer().notNull(),
    purpose: text().notNull(),
    label: text().notNull(),
    siteId: uuid(),
    workLocationId: uuid(),
    pickupPointId: uuid(),
    plannedAt: ts(),
    /** Coordinator-entered travel estimate from the previous stop. Never straight-line distance. */
    travelMinutesFromPrevious: integer(),
  },
  (t) => [
    unique().on(t.tripRevisionId, t.seq),
    foreignKey({ columns: [t.organisationId, t.tripRevisionId], foreignColumns: [tripRevisions.organisationId, tripRevisions.id] }),
  ],
);

export const tripPassengers = app.table(
  'trip_passengers',
  {
    id: id(),
    organisationId: orgId(),
    tripRevisionId: uuid().notNull(),
    workerId: uuid().notNull(),
    assignmentId: uuid(),
    boardStopSeq: integer().notNull(),
    alightStopSeq: integer().notNull(),
  },
  (t) => [
    unique().on(t.tripRevisionId, t.workerId),
    foreignKey({ columns: [t.organisationId, t.tripRevisionId], foreignColumns: [tripRevisions.organisationId, tripRevisions.id] }),
    foreignKey({ columns: [t.organisationId, t.workerId], foreignColumns: [workers.organisationId, workers.id] }),
  ],
);

export const tripAcceptances = app.table(
  'trip_acceptances',
  {
    id: id(),
    organisationId: orgId(),
    tripId: uuid().notNull(),
    tripRevisionNo: integer().notNull(),
    driverId: uuid().notNull(),
    decision: text().notNull(),
    method: text().notNull(),
    recordedBy: uuid().notNull(),
    decidedAt: ts().notNull(),
    note: text(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [foreignKey({ columns: [t.organisationId, t.tripId], foreignColumns: [trips.organisationId, trips.id] })],
);

/** Each leg (outbound, return) of each assignment must be covered explicitly. */
export const transportRequirements = app.table(
  'transport_requirements',
  {
    id: id(),
    organisationId: orgId(),
    assignmentId: uuid().notNull(),
    leg: text().notNull(),
    /** agency_trip | private_confirmed | not_required | unresolved */
    mode: text().notNull().default('unresolved'),
    rawLabel: text(),
    tripId: uuid(),
    accountableMembershipId: uuid(),
    /** For returns with unknown finish: how the pickup will be arranged. */
    arrangementNote: text(),
    ...audited(),
  },
  (t) => [
    unique().on(t.assignmentId, t.leg),
    foreignKey({ columns: [t.organisationId, t.assignmentId], foreignColumns: [assignments.organisationId, assignments.id] }),
  ],
);

// ---------------------------------------------------------------- work management

export const tasks = app.table(
  'tasks',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid(),
    type: text().notNull(),
    title: text().notNull(),
    entityType: text(),
    entityId: uuid(),
    ownerMembershipId: uuid(),
    dueAt: ts(),
    priority: text().notNull().default('normal'),
    state: text().notNull().default('open'),
    /** Raised when nobody is on duty to own an urgent task. */
    coverageAlert: boolean().notNull().default(false),
    outcome: text(),
    completedBy: uuid(),
    completedAt: ts(),
    dedupeKey: text(),
    ...audited(),
  },
  (t) => [
    unique().on(t.organisationId, t.id),
    index().on(t.organisationId, t.ownerMembershipId, t.state, t.dueAt),
    index().on(t.organisationId, t.entityType, t.entityId),
    uniqueIndex('tasks_open_dedupe')
      .on(t.organisationId, t.dedupeKey)
      .where(sql`state in ('open','in_progress') and dedupe_key is not null`),
  ],
);

export const cases = app.table(
  'cases',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid(),
    type: text().notNull(),
    severity: text().notNull().default('normal'),
    ownerMembershipId: uuid(),
    summary: text().notNull(),
    affected: jsonb().notNull().default([]),
    restrictedNotes: text(),
    state: text().notNull().default('open'),
    outcome: text(),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id)],
);

export const handoverSnapshots = app.table(
  'handover_snapshots',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    outgoingMembershipId: uuid().notNull(),
    incomingMembershipId: uuid().notNull(),
    asOf: ts().notNull(),
    taskIds: uuid().array().notNull(),
    summary: jsonb().notNull(),
    note: text(),
    acknowledgedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [foreignKey({ columns: [t.organisationId, t.branchId], foreignColumns: [branches.organisationId, branches.id] })],
);

// ---------------------------------------------------------------- communications

/** A revision-bound message. A copied message is not a sent message; provider delivery is not agreement. */
export const messageDrafts = app.table(
  'message_drafts',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    template: text().notNull(),
    templateVersion: integer().notNull(),
    recipientKind: text().notNull(),
    recipientWorkerId: uuid(),
    recipientDriverId: uuid(),
    recipientClientContactId: uuid(),
    contactPointId: uuid(),
    contactValue: text(),
    entityType: text().notNull(),
    entityId: uuid().notNull(),
    /** Line version or trip revision this message describes. */
    entityRevision: integer().notNull(),
    assignmentId: uuid(),
    content: text().notNull(),
    state: text().notNull().default('draft'),
    copiedAt: ts(),
    sentAt: ts(),
    sentBy: uuid(),
    sentChannel: text(),
    acknowledgedAt: ts(),
    endedAt: ts(),
    endReason: text(),
    ...audited(),
  },
  (t) => [unique().on(t.organisationId, t.id), index().on(t.organisationId, t.entityType, t.entityId, t.state)],
);

/** JoinedUp remains the system of record. "Exported" is not "confirmed in JoinedUp". */
export const externalBookings = app.table(
  'external_bookings',
  {
    id: id(),
    organisationId: orgId(),
    branchId: uuid().notNull(),
    assignmentId: uuid().notNull(),
    provider: text().notNull().default('joinedup'),
    state: text().notNull().default('pending_entry'),
    lineVersion: integer().notNull(),
    externalBookingId: text(),
    enteredBy: uuid(),
    enteredAt: ts(),
    verifiedBy: uuid(),
    verifiedAt: ts(),
    evidenceNote: text(),
    ...audited(),
  },
  (t) => [
    unique().on(t.assignmentId, t.provider),
    foreignKey({ columns: [t.organisationId, t.assignmentId], foreignColumns: [assignments.organisationId, assignments.id] }),
  ],
);

// ---------------------------------------------------------------- reliability and audit

export const outboxEvents = app.table(
  'outbox_events',
  {
    id: id(),
    organisationId: orgId(),
    eventType: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid().notNull(),
    entityRevision: integer(),
    /** Identifiers and metadata only — no bank details, health notes or document contents. */
    payload: jsonb().notNull().default({}),
    state: text().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: ts().notNull().defaultNow(),
    lastError: text(),
    createdAt: ts().notNull().defaultNow(),
    processedAt: ts(),
  },
  (t) => [index('outbox_pending').on(t.state, t.nextAttemptAt)],
);

/** Append-only. The runtime role has INSERT/SELECT only. */
export const auditEvents = app.table(
  'audit_events',
  {
    id: id(),
    organisationId: orgId(),
    actorMembershipId: uuid(),
    actorSystem: text(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid(),
    before: jsonb(),
    after: jsonb(),
    reason: text(),
    requestId: text(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.organisationId, t.entityType, t.entityId, t.createdAt)],
);

export const idempotencyKeys = app.table(
  'idempotency_keys',
  {
    organisationId: orgId(),
    actorId: uuid().notNull(),
    operation: text().notNull(),
    key: text().notNull(),
    requestHash: text().notNull(),
    response: jsonb(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organisationId, t.actorId, t.operation, t.key] })],
);

export const integrationSettings = app.table(
  'integration_settings',
  {
    organisationId: orgId(),
    provider: text().notNull(),
    status: text().notNull().default('disabled'),
    note: text(),
    lastSyncAt: ts(),
    lastError: text(),
    updatedAt: ts().notNull().defaultNow(),
    updatedBy: uuid(),
  },
  (t) => [primaryKey({ columns: [t.organisationId, t.provider] })],
);

export const sequences = app.table(
  'reference_sequences',
  {
    organisationId: orgId(),
    name: text().notNull(),
    nextValue: integer().notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.organisationId, t.name] })],
);
