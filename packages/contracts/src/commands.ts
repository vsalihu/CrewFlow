import { z } from 'zod';
import { isLocalDate, isLocalTime } from './time';

// Shared input schemas. Server validation is authoritative; the UI reuses them for
// immediate feedback. Unknown properties are rejected (strict objects).

const uuid = z.uuid();
const localDate = z.string().refine(isLocalDate, 'Use YYYY-MM-DD');
const localTime = z.string().refine(isLocalTime, 'Use HH:mm (24-hour)');
const count = z.number().int().min(0).max(10_000);
const text = (max = 2000) => z.string().trim().min(1).max(max);

export const lineInputSchema = z.strictObject({
  serviceDate: localDate,
  siteId: uuid.nullish(),
  workLocationId: uuid.nullish(),
  role: text(200).nullish(),
  requiredSkill: text(200).nullish(),
  teamLabel: text(200).nullish(),
  requestedCount: count,
  minimumCount: count.nullish(),
  arrivalLocal: localTime.nullish(),
  startLocal: localTime.nullish(),
  startWindowEndLocal: localTime.nullish(),
  endLocal: localTime.nullish(),
  /** 1 when the shift ends on the following calendar day. Never inferred. */
  endDayOffset: z.union([z.literal(0), z.literal(1)]).optional(),
  timezone: z.string().min(1).max(64).optional(),
  breakRule: text(500).nullish(),
  notes: text(2000).nullish(),
});
export type LineInput = z.input<typeof lineInputSchema>;

export const captureSourceSchema = z.strictObject({
  branchId: uuid,
  kind: z.enum(['pasted_message', 'phone_note', 'email']),
  conversationId: uuid.nullish(),
  providerMessageId: z.string().max(500).nullish(),
  senderLabel: text(200).nullish(),
  clientContactId: uuid.nullish(),
  receivedAt: z.iso.datetime({ offset: true }),
  rawText: z.string().min(1).max(100_000),
  callerName: text(200).nullish(),
});
export type CaptureSourceInput = z.input<typeof captureSourceSchema>;

export const createOrderSchema = z.strictObject({
  branchId: uuid,
  clientId: uuid,
  clientContactId: uuid.nullish(),
  ownerMembershipId: uuid.nullish(),
  sourceMessageIds: z.array(uuid).min(1, 'Link at least one source message or phone note.'),
  sourceAuthority: text(200).nullish(),
  requestState: z.enum(['received', 'needs_clarification', 'draft']).optional(),
  lines: z.array(lineInputSchema).min(1),
});
export type CreateOrderInput = z.input<typeof createOrderSchema>;

export const lineChangeSchema = lineInputSchema.partial().extend({ lineId: uuid });
export type LineChange = z.input<typeof lineChangeSchema>;

export const amendmentSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  sourceMessageIds: z.array(uuid).min(1, 'Link the message or note that asked for this change.'),
  reason: text(1000),
  lineChanges: z.array(lineChangeSchema).default([]),
  addLines: z.array(lineInputSchema).default([]),
  acknowledgeImpactToken: z.string().min(1).optional(),
});
export type AmendmentInput = z.input<typeof amendmentSchema>;

export const acceptanceSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  decisions: z.array(z.strictObject({ lineId: uuid, acceptedCount: count })).min(1),
  note: text(1000).nullish(),
});
export type AcceptanceInput = z.input<typeof acceptanceSchema>;

export const cancellationSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  scope: z.enum(['order', 'lines', 'assignments']),
  lineIds: z.array(uuid).optional(),
  assignmentIds: z.array(uuid).optional(),
  reason: text(1000),
  sourceMessageIds: z.array(uuid).default([]),
});
export type CancellationInput = z.input<typeof cancellationSchema>;

export const raiseConflictSchema = z.strictObject({
  lineId: uuid.nullish(),
  fieldPath: text(100),
  observations: z
    .array(z.strictObject({ value: z.string().max(500), sourceMessageId: uuid.nullish(), note: z.string().max(1000).nullish() }))
    .min(2, 'A conflict needs at least two observed values.'),
});
export type RaiseConflictInput = z.input<typeof raiseConflictSchema>;

export const resolveConflictSchema = z.strictObject({
  resolvedValue: z.string().max(500),
  note: text(1000),
});
export type ResolveConflictInput = z.input<typeof resolveConflictSchema>;

export const proposeAssignmentsSchema = z.strictObject({
  workers: z.array(z.strictObject({ workerId: uuid, rawTransportLabel: z.string().max(100).nullish() })).min(1),
});
export type ProposeAssignmentsInput = z.input<typeof proposeAssignmentsSchema>;

export const workerResponseSchema = z.strictObject({
  lineVersion: z.number().int().min(1),
  response: z.enum(['accepted', 'declined', 'no_answer', 'ambiguous']),
  channel: z.enum(['phone', 'whatsapp_manual', 'sms_manual', 'email', 'in_person', 'portal_link']),
  respondedAt: z.iso.datetime({ offset: true }),
  evidenceNote: z.string().max(2000).nullish(),
});
export type WorkerResponseInput = z.input<typeof workerResponseSchema>;

const stopSchema = z.strictObject({
  purpose: z.enum(['pickup', 'dropoff', 'driver_own_work']),
  label: text(300),
  siteId: uuid.nullish(),
  workLocationId: uuid.nullish(),
  pickupPointId: uuid.nullish(),
  plannedAt: z.iso.datetime({ offset: true }).nullish(),
  travelMinutesFromPrevious: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .nullish(),
});

const passengerSchema = z.strictObject({
  workerId: uuid,
  assignmentId: uuid.nullish(),
  boardStopSeq: z.number().int().min(1),
  alightStopSeq: z.number().int().min(1),
});

export const tripManifestSchema = z.strictObject({
  driverId: uuid.nullish(),
  vehicleId: uuid.nullish(),
  plannedDepartureAt: z.iso.datetime({ offset: true }).nullish(),
  estimatedEndAt: z.iso.datetime({ offset: true }).nullish(),
  driverOwnAssignmentId: uuid.nullish(),
  stops: z.array(stopSchema).min(2, 'A journey needs at least two stops.'),
  passengers: z.array(passengerSchema).default([]),
});
export type TripManifestInput = z.input<typeof tripManifestSchema>;

export const createTripSchema = tripManifestSchema.extend({
  branchId: uuid,
  serviceDate: localDate,
  legType: z.enum(['outbound', 'return', 'ad_hoc', 'repositioning']),
});
export type CreateTripInput = z.input<typeof createTripSchema>;

export const reviseTripSchema = tripManifestSchema.extend({
  expectedVersion: z.number().int().min(1),
  reason: text(1000),
});
export type ReviseTripInput = z.input<typeof reviseTripSchema>;

export const tripAcceptanceSchema = z.strictObject({
  revisionNo: z.number().int().min(1),
  decision: z.enum(['accepted', 'declined']),
  method: z.enum(['phone', 'whatsapp_manual', 'sms_manual', 'in_person', 'portal_link']),
  decidedAt: z.iso.datetime({ offset: true }),
  note: z.string().max(2000).nullish(),
});
export type TripAcceptanceInput = z.input<typeof tripAcceptanceSchema>;

export const transportRequirementSchema = z.strictObject({
  leg: z.enum(['outbound', 'return']),
  mode: z.enum(['agency_trip', 'private_confirmed', 'not_required', 'unresolved']),
  accountableMembershipId: uuid.nullish(),
  arrangementNote: z.string().max(1000).nullish(),
});
export type TransportRequirementInput = z.input<typeof transportRequirementSchema>;

export const draftMessageSchema = z.strictObject({
  template: z.enum(['worker_offer', 'worker_booking', 'driver_manifest', 'amendment', 'cancellation', 'client_receipt', 'agency_acceptance']),
  assignmentId: uuid.nullish(),
  tripId: uuid.nullish(),
  orderId: uuid.nullish(),
});
export type DraftMessageInput = z.input<typeof draftMessageSchema>;

export const manualSentSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  channel: z.enum(['whatsapp_manual', 'sms_manual', 'phone', 'email', 'in_person']),
  sentAt: z.iso.datetime({ offset: true }),
});
export type ManualSentInput = z.input<typeof manualSentSchema>;

export const externalBookingUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  action: z.enum(['entered', 'verified', 'failed', 'discrepancy', 'cancellation_verified']),
  externalBookingId: z.string().trim().max(200).nullish(),
  evidenceNote: z.string().trim().max(2000).nullish(),
});
export type ExternalBookingUpdateInput = z.input<typeof externalBookingUpdateSchema>;

export const taskOutcomeSchema = z.strictObject({
  outcome: z.string().max(4000),
  expectedVersion: z.number().int().min(1).optional(),
});

/** Parsed (defaults applied) shapes used inside domain services after validation. */
export type Amendment = z.output<typeof amendmentSchema>;
export type TripManifest = z.output<typeof tripManifestSchema>;
