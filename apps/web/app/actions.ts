'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { createServerClient } from '@supabase/ssr';
import { DomainError, isDomainError, lineInputSchema, resolveLocal, type LineInput } from '@cds/contracts';
import {
  acknowledgeHandover,
  addTripPassenger,
  cancelOrder,
  cancelTrip,
  captureSource,
  completeTask,
  createHandover,
  createOrder,
  createTrip,
  decideAcceptance,
  generateDraft,
  markDraftCopied,
  markManuallySent,
  proposeAssignments,
  proposeTripToDriver,
  publishTrip,
  raiseConflict,
  recordMessageAcknowledged,
  recordReplacementDeclined,
  recordTripAcceptance,
  recordWorkerResponse,
  releaseAssignment,
  reportTripDisruption,
  requestReturnPickup,
  resolveConflict,
  setTransportRequirement,
  setTripProgress,
  updateExternalBooking,
  amendOrder,
  type ServiceContext,
} from '@cds/domain';
import { DEV_COOKIE, requireContext } from '@/lib/session';
import { devAuthEnabled, env } from '@/lib/env';

// Server actions behind the staff screens. Each one calls a domain service; business-rule
// refusals come back to the page as a visible message, never as a silent failure.

function withParam(path: string, key: string, value: string): string {
  const [base, query] = path.split('?');
  const params = new URLSearchParams(query);
  params.delete('error');
  params.delete('notice');
  params.set(key, value);
  return `${base}?${params.toString()}`;
}

function describe(e: unknown): string | null {
  if (isDomainError(e)) {
    const details = e.violations.slice(0, 4).map((v) => v.message);
    const fields = Object.values(e.fieldErrors).flat().slice(0, 3);
    return [e.message, ...details, ...fields].join(' ');
  }
  if (e instanceof ZodError)
    return `Check the form: ${e.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'value'} ${i.message}`)
      .join('; ')}`;
  return null;
}

async function run(back: string, fn: (ctx: ServiceContext) => Promise<string | { notice: string; goto?: string } | void>): Promise<never> {
  const ctx = await requireContext();
  let result: Awaited<ReturnType<typeof fn>>;
  try {
    result = await fn(ctx);
  } catch (e) {
    const msg = describe(e);
    if (msg) redirect(withParam(back, 'error', msg));
    throw e;
  }
  revalidatePath('/', 'layout');
  const notice = typeof result === 'string' ? result : (result?.notice ?? 'Saved.');
  const goto = typeof result === 'object' && result?.goto ? result.goto : back;
  redirect(withParam(goto, 'notice', notice));
}

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
};
const req = (f: FormData, k: string) => {
  const v = str(f, k);
  if (v === null) throw new ZodError([{ code: 'custom', path: [k], message: 'is required', input: undefined }]);
  return v;
};
const int = (f: FormData, k: string) => Number.parseInt(req(f, k), 10);
/** datetime-local value (Europe/London wall clock) → ISO instant. DST gaps/overlaps are refused, not guessed. */
function localToIso(v: string): string {
  const [d, t] = v.split('T');
  const r = resolveLocal(d ?? '', (t ?? '').slice(0, 5), 'Europe/London');
  if (r.kind === 'ok') return r.instant.toISOString();
  throw new DomainError(
    'VALIDATION_FAILED',
    r.kind === 'ambiguous' ? `${v} happens twice when the clocks go back; confirm which.` : `${v} is not a valid local time.`,
  );
}

// ------------------------------------------------------------------ session

export async function devSignIn(formData: FormData) {
  if (!devAuthEnabled()) redirect('/login?error=Development+sign-in+is+disabled');
  const id = req(formData, 'authUserId');
  (await cookies()).set(DEV_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: env().APP_ENV !== 'development', path: '/' });
  redirect('/operations');
}

export async function passwordSignIn(formData: FormData) {
  const e = env();
  if (!e.SUPABASE_URL || !e.SUPABASE_PUBLISHABLE_KEY) redirect('/login?error=Supabase+Auth+is+not+configured');
  const jar = await cookies();
  const supabase = createServerClient(e.SUPABASE_URL, e.SUPABASE_PUBLISHABLE_KEY, {
    cookies: { getAll: () => jar.getAll(), setAll: (cs) => cs.forEach((c) => jar.set(c.name, c.value, c.options)) },
  });
  const { error } = await supabase.auth.signInWithPassword({ email: req(formData, 'email'), password: req(formData, 'password') });
  if (error) redirect('/login?error=Sign-in+failed.+Check+your+email+and+password.');
  redirect('/operations');
}

export async function signOut() {
  const jar = await cookies();
  jar.delete(DEV_COOKIE);
  const e = env();
  if (e.SUPABASE_URL && e.SUPABASE_PUBLISHABLE_KEY) {
    const supabase = createServerClient(e.SUPABASE_URL, e.SUPABASE_PUBLISHABLE_KEY, {
      cookies: { getAll: () => jar.getAll(), setAll: (cs) => cs.forEach((c) => jar.set(c.name, c.value, c.options)) },
    });
    await supabase.auth.signOut();
  }
  redirect('/login');
}

// ------------------------------------------------------------------ orders

export async function createOrderFromSource(formData: FormData) {
  await run('/orders/new', async (ctx) => {
    const branchId = req(formData, 'branchId');
    const kind = req(formData, 'kind') as 'pasted_message' | 'phone_note' | 'email';
    const lines = (JSON.parse(req(formData, 'lines')) as unknown[]).map((l) => lineInputSchema.parse(l)) as LineInput[];
    const source = await captureSource(ctx, {
      branchId,
      kind,
      rawText: req(formData, 'rawText'),
      receivedAt: localToIso(req(formData, 'receivedAt')),
      senderLabel: str(formData, 'senderLabel'),
      callerName: str(formData, 'callerName'),
    });
    const o = await createOrder(ctx, {
      branchId,
      clientId: req(formData, 'clientId'),
      sourceMessageIds: [source.id],
      requestState: str(formData, 'needsClarification') ? 'needs_clarification' : 'received',
      lines,
    });
    return {
      notice: `Order ${o.reference} saved${o.urgency !== 'normal' ? ` (${o.urgency})` : ''}. Nothing is accepted until you decide.`,
      goto: `/orders/${o.id}`,
    };
  });
}

export async function acceptOrder(formData: FormData) {
  const orderId = req(formData, 'orderId');
  await run(`/orders/${orderId}`, async (ctx) => {
    const decisions = formData.getAll('lineId').map((id) => ({ lineId: String(id), acceptedCount: int(formData, `accepted_${id}`) }));
    const r = await decideAcceptance(ctx, orderId, { expectedVersion: int(formData, 'version'), decisions, note: str(formData, 'note') });
    return `Agency decision recorded: ${r.requestState.replaceAll('_', ' ')}.`;
  });
}

export async function raiseConflictAction(formData: FormData) {
  const orderId = req(formData, 'orderId');
  await run(`/orders/${orderId}`, async (ctx) => {
    await raiseConflict(ctx, orderId, {
      lineId: str(formData, 'lineId'),
      fieldPath: req(formData, 'fieldPath'),
      observations: [
        { value: req(formData, 'valueA'), note: str(formData, 'noteA') },
        { value: req(formData, 'valueB'), note: str(formData, 'noteB') },
      ],
    });
    return 'Conflict recorded. Instructions for this line are blocked until it is resolved.';
  });
}

export async function resolveConflictAction(formData: FormData) {
  const orderId = req(formData, 'orderId');
  await run(`/orders/${orderId}`, async (ctx) => {
    await resolveConflict(ctx, req(formData, 'conflictId'), { resolvedValue: req(formData, 'resolvedValue'), note: req(formData, 'note') });
    return 'Conflict resolved. If the order needs to change, amend it now.';
  });
}

/** Step 1 of an amendment: capture what asked for it, then show the impact preview. */
export async function prepareAmendmentAction(formData: FormData) {
  const orderId = req(formData, 'orderId');
  const lineId = req(formData, 'lineId');
  const base = `/orders/${orderId}/lines/${lineId}/amend`;
  await run(base, async (ctx) => {
    let src = str(formData, 'sourceId');
    const raw = str(formData, 'rawText');
    if (raw) {
      src = (await captureSource(ctx, { branchId: req(formData, 'branchId'), kind: 'pasted_message', rawText: raw, receivedAt: new Date().toISOString() })).id;
    }
    if (!src) throw new ZodError([{ code: 'custom', path: ['source'], message: 'link or paste the message that asked for this change', input: undefined }]);
    const num = (k: string) => (str(formData, k) === null ? null : Number.parseInt(str(formData, k)!, 10));
    const change = {
      serviceDate: req(formData, 'serviceDate'),
      arrivalLocal: str(formData, 'arrivalLocal')?.slice(0, 5) ?? null,
      startLocal: str(formData, 'startLocal')?.slice(0, 5) ?? null,
      endLocal: str(formData, 'endLocal')?.slice(0, 5) ?? null,
      requestedCount: num('requestedCount') ?? 0,
      minimumCount: num('minimumCount'),
      role: str(formData, 'role'),
      requiredSkill: str(formData, 'requiredSkill'),
      teamLabel: str(formData, 'teamLabel'),
      notes: str(formData, 'notes'),
    };
    const qs = new URLSearchParams({ src, reason: req(formData, 'reason'), change: JSON.stringify(change) });
    return { notice: 'Check the impact, then save.', goto: `${base}?${qs.toString()}` };
  });
}

export async function amendLineAction(formData: FormData) {
  const orderId = req(formData, 'orderId');
  const lineId = req(formData, 'lineId');
  await run(`/orders/${orderId}`, async (ctx) => {
    const change = JSON.parse(req(formData, 'change')) as Record<string, unknown>;
    const r = await amendOrder(ctx, orderId, {
      expectedVersion: int(formData, 'version'),
      sourceMessageIds: [req(formData, 'sourceMessageId')],
      reason: req(formData, 'reason'),
      lineChanges: [{ lineId, ...change }],
      acknowledgeImpactToken: req(formData, 'token'),
    });
    return `Revision ${r.revision} saved. ${r.impact.reconfirmations.length} worker(s) must reconfirm.`;
  });
}

export async function cancelOrderAction(formData: FormData) {
  const orderId = req(formData, 'orderId');
  await run(`/orders/${orderId}`, async (ctx) => {
    const scope = req(formData, 'scope') as 'order' | 'lines' | 'assignments';
    const r = await cancelOrder(ctx, orderId, {
      expectedVersion: int(formData, 'version'),
      scope,
      lineIds: formData.getAll('lineIds').map(String),
      assignmentIds: formData.getAll('assignmentIds').map(String),
      reason: req(formData, 'reason'),
    });
    return `Cancelled ${r.cancelledAssignments} assignment(s). ${r.acknowledgementTasks} person(s) already told must acknowledge the cancellation.`;
  });
}

export async function replacementDeclinedAction(formData: FormData) {
  const orderId = req(formData, 'orderId');
  await run(`/orders/${orderId}`, async (ctx) => {
    await recordReplacementDeclined(ctx, req(formData, 'lineId'), req(formData, 'note'));
    return 'Recorded: no replacement wanted. Replacement tasks for this line are closed.';
  });
}

// ------------------------------------------------------------------ assignments

export async function proposeWorkersAction(formData: FormData) {
  const orderId = req(formData, 'orderId');
  const lineId = req(formData, 'lineId');
  await run(`/orders/${orderId}/lines/${lineId}/assign`, async (ctx) => {
    const ids = formData.getAll('workerId').map(String);
    if (!ids.length) throw new ZodError([{ code: 'custom', path: ['workerId'], message: 'select at least one worker', input: undefined }]);
    const r = await proposeAssignments(ctx, lineId, { workers: ids.map((workerId) => ({ workerId, rawTransportLabel: str(formData, `label_${workerId}`) })) });
    return { notice: `${r.assignmentIds.length} worker(s) proposed. Proposed is not confirmed: send offers and record replies.`, goto: `/orders/${orderId}` };
  });
}

export async function recordResponseAction(formData: FormData) {
  const orderId = req(formData, 'orderId');
  await run(`/orders/${orderId}`, async (ctx) => {
    const r = await recordWorkerResponse(ctx, req(formData, 'assignmentId'), {
      lineVersion: int(formData, 'lineVersion'),
      response: req(formData, 'response') as 'accepted' | 'declined' | 'no_answer' | 'ambiguous',
      channel: req(formData, 'channel') as 'phone',
      respondedAt: new Date().toISOString(),
      evidenceNote: str(formData, 'note'),
    });
    const text: Record<string, string> = {
      applied: 'Response recorded.',
      stale: 'Recorded, but it refers to an older version of the shift. A reconfirmation task was created.',
      blocked_readiness: 'Recorded, but the worker is not ready under current policy. A readiness review task was created.',
      ambiguous: 'Recorded as ambiguous. A clarification task was created.',
    };
    return text[r.outcome]!;
  });
}

export async function releaseAssignmentAction(formData: FormData) {
  const orderId = req(formData, 'orderId');
  await run(`/orders/${orderId}`, async (ctx) => {
    await releaseAssignment(ctx, req(formData, 'assignmentId'), req(formData, 'reason'));
    return 'Worker released. Tell them and record their acknowledgement.';
  });
}

// ------------------------------------------------------------------ messages

export async function draftMessageAction(formData: FormData) {
  const back = req(formData, 'back');
  await run(back, async (ctx) => {
    const d = await generateDraft(ctx, {
      template: req(formData, 'template') as 'worker_offer',
      assignmentId: str(formData, 'assignmentId'),
      tripId: str(formData, 'tripId'),
    });
    return { notice: 'Draft ready. Copy it, send it yourself, then record it as sent.', goto: `/messages/${d.id}?back=${encodeURIComponent(back)}` };
  });
}

export async function markCopiedAction(draftId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireContext();
  try {
    await markDraftCopied(ctx, draftId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describe(e) ?? 'Could not record the copy.' };
  }
}

export async function markSentAction(formData: FormData) {
  const draftId = req(formData, 'draftId');
  const back = req(formData, 'back');
  await run(`/messages/${draftId}?back=${encodeURIComponent(back)}`, async (ctx) => {
    await markManuallySent(ctx, draftId, {
      expectedVersion: int(formData, 'version'),
      channel: req(formData, 'channel') as 'whatsapp_manual',
      sentAt: new Date().toISOString(),
    });
    return { notice: 'Recorded as sent by you. This is not delivery or agreement: record the reply when it comes.', goto: back };
  });
}

export async function acknowledgeMessageAction(formData: FormData) {
  const draftId = req(formData, 'draftId');
  const back = req(formData, 'back');
  await run(`/messages/${draftId}?back=${encodeURIComponent(back)}`, async (ctx) => {
    await recordMessageAcknowledged(ctx, draftId, req(formData, 'note'));
    return { notice: 'Acknowledgement recorded.', goto: back };
  });
}

// ------------------------------------------------------------------ transport

type TripForm = {
  branchId: string;
  serviceDate: string;
  legType: 'outbound' | 'return' | 'ad_hoc' | 'repositioning';
  driverId: string | null;
  vehicleId: string | null;
  plannedDepartureAt: string | null;
  estimatedEndAt: string | null;
  driverOwnAssignmentId: string | null;
  stops: { purpose: 'pickup' | 'dropoff' | 'driver_own_work'; label: string; workLocationId: string | null; travelMinutesFromPrevious: number | null }[];
  passengers: { workerId: string; assignmentId: string | null; boardStopSeq: number; alightStopSeq: number }[];
};

export async function createTripAction(formData: FormData) {
  await run('/transport/new', async (ctx) => {
    const t = JSON.parse(req(formData, 'trip')) as TripForm;
    const r = await createTrip(ctx, {
      ...t,
      plannedDepartureAt: t.plannedDepartureAt ? localToIso(t.plannedDepartureAt) : null,
      estimatedEndAt: t.estimatedEndAt ? localToIso(t.estimatedEndAt) : null,
    });
    return { notice: `Journey ${r.reference} drafted. Check the validation, then propose it to the driver.`, goto: `/trips/${r.id}` };
  });
}

export async function addPassengerAction(formData: FormData) {
  const tripId = req(formData, 'tripId');
  await run(`/trips/${tripId}`, async (ctx) => {
    const [workerId, assignmentId] = req(formData, 'passenger').split('|');
    const r = await addTripPassenger(ctx, tripId, {
      workerId: workerId!,
      assignmentId: assignmentId || null,
      boardStopSeq: int(formData, 'board'),
      alightStopSeq: int(formData, 'alight'),
    });
    return `Passenger added as revision ${r.revisionNo}. The driver must accept this revision.`;
  });
}

export async function proposeTripAction(formData: FormData) {
  const tripId = req(formData, 'tripId');
  await run(`/trips/${tripId}`, async (ctx) => {
    await proposeTripToDriver(ctx, tripId, int(formData, 'version'));
    return 'Proposed. Call the driver and record their answer for this revision.';
  });
}

export async function tripAcceptanceAction(formData: FormData) {
  const tripId = req(formData, 'tripId');
  await run(`/trips/${tripId}`, async (ctx) => {
    const r = await recordTripAcceptance(ctx, tripId, {
      revisionNo: int(formData, 'revisionNo'),
      decision: req(formData, 'decision') as 'accepted' | 'declined',
      method: req(formData, 'method') as 'phone',
      decidedAt: new Date().toISOString(),
      note: str(formData, 'note'),
    });
    return r.outcome === 'stale'
      ? 'Recorded, but it was for an older revision and does not count.'
      : `Driver ${req(formData, 'decision')} revision ${req(formData, 'revisionNo')}.`;
  });
}

export async function publishTripAction(formData: FormData) {
  const tripId = req(formData, 'tripId');
  await run(`/trips/${tripId}`, async (ctx) => {
    await publishTrip(ctx, tripId, int(formData, 'version'));
    return 'Journey published. Passengers on it now have this leg covered.';
  });
}

export async function tripProgressAction(formData: FormData) {
  const tripId = req(formData, 'tripId');
  await run(`/trips/${tripId}`, async (ctx) => {
    await setTripProgress(ctx, tripId, req(formData, 'state') as 'departed' | 'completed', int(formData, 'version'));
    return 'Journey updated.';
  });
}

export async function disruptionAction(formData: FormData) {
  const tripId = req(formData, 'tripId');
  await run(`/trips/${tripId}`, async (ctx) => {
    const r = await reportTripDisruption(ctx, tripId, { kind: req(formData, 'kind') as 'breakdown', note: req(formData, 'note') });
    return `Disruption recorded. ${r.affectedPassengers} passenger(s) affected; replacement and client ETA tasks created.`;
  });
}

export async function cancelTripAction(formData: FormData) {
  const tripId = req(formData, 'tripId');
  await run(`/trips/${tripId}`, async (ctx) => {
    const r = await cancelTrip(ctx, tripId, { expectedVersion: int(formData, 'version'), reason: req(formData, 'reason') });
    return `Journey cancelled. ${r.affectedPassengers} passenger leg(s) need transport again.`;
  });
}

export async function transportRequirementAction(formData: FormData) {
  const back = req(formData, 'back');
  await run(back, async (ctx) => {
    await setTransportRequirement(ctx, req(formData, 'assignmentId'), {
      leg: req(formData, 'leg') as 'outbound' | 'return',
      mode: req(formData, 'mode') as 'private_confirmed' | 'not_required' | 'unresolved',
      accountableMembershipId: str(formData, 'mode') === 'unresolved' ? (ctx.actor.kind === 'staff' ? ctx.actor.membershipId : null) : null,
      arrangementNote: str(formData, 'note'),
    });
    return 'Transport arrangement recorded.';
  });
}

export async function returnPickupAction(formData: FormData) {
  const back = req(formData, 'back');
  await run(back, async (ctx) => {
    await requestReturnPickup(ctx, {
      assignmentIds: formData.getAll('assignmentId').map(String),
      pickupAt: new Date(localToIso(req(formData, 'pickupAt'))),
      reason: req(formData, 'reason') as 'finished' | 'unwell' | 'other',
      restrictedNote: str(formData, 'restrictedNote'),
    });
    return 'Pickup request recorded as an urgent task.';
  });
}

// ------------------------------------------------------------------ JoinedUp, tasks, handover

export async function externalBookingAction(formData: FormData) {
  await run('/joinedup', async (ctx) => {
    const r = await updateExternalBooking(ctx, req(formData, 'id'), {
      expectedVersion: int(formData, 'version'),
      action: req(formData, 'action') as 'entered',
      externalBookingId: str(formData, 'externalBookingId'),
      evidenceNote: str(formData, 'evidenceNote'),
    });
    return `JoinedUp booking now ${r.state.replaceAll('_', ' ')}.`;
  });
}

export async function completeTaskAction(formData: FormData) {
  const back = req(formData, 'back');
  await run(back, async (ctx) => {
    await completeTask(ctx, { taskId: req(formData, 'taskId'), outcome: req(formData, 'outcome'), expectedVersion: int(formData, 'version') });
    return 'Task completed with its outcome recorded.';
  });
}

export async function createHandoverAction(formData: FormData) {
  await run('/handover', async (ctx) => {
    const r = await createHandover(ctx, {
      branchId: req(formData, 'branchId'),
      incomingMembershipId: req(formData, 'incomingMembershipId'),
      note: str(formData, 'note'),
    });
    return `Handed over ${r.taskCount} task(s). The incoming person must acknowledge.`;
  });
}

export async function acknowledgeHandoverAction(formData: FormData) {
  await run('/handover', async (ctx) => {
    await acknowledgeHandover(ctx, req(formData, 'handoverId'));
    return 'Handover acknowledged. These tasks are yours now.';
  });
}
