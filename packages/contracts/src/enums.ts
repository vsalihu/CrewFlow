// State dimensions are deliberately separate (build plan §6). Do not merge them
// into one "status" — demand, staffing, transport and attendance change independently.

export const REQUEST_STATES = ['draft', 'needs_clarification', 'received', 'accepted', 'partially_accepted', 'declined', 'cancelled', 'closed'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const STAFFING_STATES = ['unfilled', 'partly_proposed', 'proposed_full', 'partly_confirmed', 'confirmed_full', 'over_allocated'] as const;
export type StaffingState = (typeof STAFFING_STATES)[number];

export const TRANSPORT_STATES = ['not_required', 'unplanned', 'proposed', 'awaiting_acceptance', 'ready', 'disrupted', 'completed'] as const;
export type TransportState = (typeof TRANSPORT_STATES)[number];

export const EXTERNAL_BOOKING_STATES = [
  'not_required',
  'pending_entry',
  'entered_unverified',
  'verified',
  'failed',
  'discrepancy',
  'cancelled_verified',
] as const;
export type ExternalBookingState = (typeof EXTERNAL_BOOKING_STATES)[number];

export const ASSIGNMENT_STATES = [
  'proposed',
  'offered',
  'accepted',
  'reconfirmation_required',
  'declined',
  'cancelled',
  'superseded',
  'arrived',
  'no_show',
  'completed',
] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

/** Assignment states that hold a slot on the line and a reservation on the worker. */
export const ACTIVE_ASSIGNMENT_STATES: readonly AssignmentState[] = ['proposed', 'offered', 'accepted', 'reconfirmation_required', 'arrived'];

export const WORKER_RESPONSES = ['accepted', 'declined', 'no_answer', 'ambiguous'] as const;
export type WorkerResponse = (typeof WORKER_RESPONSES)[number];

export const RESPONSE_CHANNELS = ['phone', 'whatsapp_manual', 'sms_manual', 'email', 'in_person', 'portal_link'] as const;
export type ResponseChannel = (typeof RESPONSE_CHANNELS)[number];

export const TRIP_LEG_TYPES = ['outbound', 'return', 'ad_hoc', 'repositioning'] as const;
export type TripLegType = (typeof TRIP_LEG_TYPES)[number];

export const TRIP_STATES = ['draft', 'proposed', 'driver_accepted', 'published', 'departed', 'completed', 'disrupted', 'cancelled'] as const;
export type TripState = (typeof TRIP_STATES)[number];

export const STOP_PURPOSES = ['pickup', 'dropoff', 'driver_own_work'] as const;
export type StopPurpose = (typeof STOP_PURPOSES)[number];

export const TRANSPORT_REQUIREMENT_MODES = ['agency_trip', 'private_confirmed', 'not_required', 'unresolved'] as const;
export type TransportRequirementMode = (typeof TRANSPORT_REQUIREMENT_MODES)[number];

export const TRANSPORT_LEGS = ['outbound', 'return'] as const;
export type TransportLeg = (typeof TRANSPORT_LEGS)[number];

export const MESSAGE_TEMPLATES = [
  'client_receipt',
  'agency_acceptance',
  'worker_offer',
  'worker_booking',
  'driver_manifest',
  'amendment',
  'cancellation',
  'arrival_issue',
  'return_pickup',
  'timesheet_reminder',
] as const;
export type MessageTemplate = (typeof MESSAGE_TEMPLATES)[number];

export const MESSAGE_DRAFT_STATES = [
  'draft',
  'copied',
  'queued',
  'manually_marked_sent',
  'provider_accepted',
  'delivered',
  'delivery_unknown',
  'failed',
  'acknowledged',
  'superseded',
  'withdrawn',
] as const;
export type MessageDraftState = (typeof MESSAGE_DRAFT_STATES)[number];

export const TASK_STATES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_PRIORITIES = ['normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const SOURCE_KINDS = ['pasted_message', 'phone_note', 'email', 'portal', 'import'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_LINK_RELATIONS = ['request', 'amendment', 'confirmation', 'dispute', 'cancellation'] as const;
export type SourceLinkRelation = (typeof SOURCE_LINK_RELATIONS)[number];

export const READINESS_STATUSES = ['unknown', 'pending', 'cleared', 'expired', 'blocked'] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const READINESS_POLICIES = ['blocking', 'warning', 'not_required'] as const;
export type ReadinessPolicy = (typeof READINESS_POLICIES)[number];

export const READINESS_SCOPES = ['worker', 'worker_site', 'site', 'client'] as const;
export type ReadinessScope = (typeof READINESS_SCOPES)[number];

export const INTEGRATION_STATUSES = ['disabled', 'manual', 'sandbox', 'connected', 'degraded', 'blocked'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const CONFLICT_STATES = ['open', 'resolved'] as const;
export type ConflictState = (typeof CONFLICT_STATES)[number];

export const URGENCY_LEVELS = ['normal', 'late', 'urgent'] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];
