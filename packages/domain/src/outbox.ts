import { and, eq, sql } from 'drizzle-orm';
import { isDomainError } from '@cds/contracts';
import type { SystemActor } from '@cds/auth';
import { branches, messageDrafts, outboxEvents, withContext, type Db } from '@cds/db';
import type { MessagingAdapter } from '@cds/integrations';
import { command, type ServiceContext } from './context';
import { assertDraftCurrent } from './messages';
import { createTask } from './tasks';

// Transactional outbox processing (build plan §15.3, §20). State changes and outbox rows are
// committed together; this processor performs side effects afterwards with retries.
// External effects are at-least-once attempts, so every send is guarded by business checks.

export const RETRY_MINUTES = [1, 5, 15, 60];

type ClaimedEvent = {
  id: string;
  organisation_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  entity_revision: number | null;
  payload: Record<string, unknown>;
  attempts: number;
};

export type OutboxAdapters = { messaging: MessagingAdapter };
export type OutboxOutcome = 'done' | 'skipped_stale' | 'manual_required' | 'retry' | 'failed';

async function systemActor(db: Db, organisationId: string): Promise<SystemActor> {
  const rows = await withContext(db, { organisationId, branchIds: [] }, (tx) => tx.select({ id: branches.id }).from(branches));
  return { kind: 'system', name: 'outbox-worker', organisationId, branchIds: rows.map((r) => r.id) };
}

async function finish(db: Db, actor: SystemActor, e: ClaimedEvent, outcome: OutboxOutcome, error: string | null, now: Date): Promise<void> {
  await withContext(db, { organisationId: actor.organisationId, branchIds: actor.branchIds }, async (tx) => {
    if (outcome === 'retry') {
      const minutes = RETRY_MINUTES[Math.min(e.attempts - 1, RETRY_MINUTES.length - 1)]!;
      const jitter = Math.floor(Math.random() * 20_000);
      await tx
        .update(outboxEvents)
        .set({ state: 'pending', lastError: error, nextAttemptAt: new Date(now.getTime() + minutes * 60_000 + jitter) })
        .where(eq(outboxEvents.id, e.id));
    } else {
      await tx.update(outboxEvents).set({ state: outcome, lastError: error, processedAt: now }).where(eq(outboxEvents.id, e.id));
    }
  });
}

/** Send a queued message. The draft is marked delivery_unknown *before* the provider call. */
async function dispatchMessage(ctx: ServiceContext, adapters: OutboxAdapters, e: ClaimedEvent): Promise<{ outcome: OutboxOutcome; error: string | null }> {
  const prepared = await command(ctx, { operation: 'outbox.message.prepare' }, async (tx) => {
    const [d] = await tx.select().from(messageDrafts).where(eq(messageDrafts.id, e.entity_id)).for('update');
    if (!d) return { skip: 'Draft no longer exists' } as const;
    if (d.state !== 'queued') {
      if (d.state === 'delivery_unknown') {
        // A previous attempt may have reached the provider. Do not resend; ask a person.
        await createTask(tx, ctx, {
          branchId: d.branchId,
          type: 'reconcile_delivery',
          title: 'Check whether a queued message was delivered before re-sending it',
          entityType: 'message_draft',
          entityId: d.id,
          priority: 'high',
          dedupeKey: `reconcile:${d.id}`,
        });
      }
      return { skip: `Draft is ${d.state}` } as const;
    }
    if (d.entityRevision !== e.entity_revision) return { skip: 'Event revision differs from draft' } as const;
    try {
      await assertDraftCurrent(tx, d);
    } catch (err) {
      if (!isDomainError(err)) throw err;
      await tx.update(messageDrafts).set({ state: 'superseded', endedAt: new Date(), endReason: err.message, version: d.version + 1 }).where(eq(messageDrafts.id, d.id));
      return { skip: err.message } as const;
    }
    await tx.update(messageDrafts).set({ state: 'delivery_unknown', version: d.version + 1 }).where(eq(messageDrafts.id, d.id));
    return { draft: d } as const;
  });
  if ('skip' in prepared) return { outcome: 'skipped_stale', error: prepared.skip ?? null };

  const d = prepared.draft;
  const result = await adapters.messaging.send({ draftId: d.id, to: d.contactValue ?? '', body: d.content, idempotencyKey: `${d.id}:${d.entityRevision}` });
  return command(ctx, { operation: 'outbox.message.result' }, async (tx) => {
    if (result.kind === 'accepted') {
      await tx.update(messageDrafts).set({ state: 'provider_accepted', sentAt: new Date(), sentChannel: 'whatsapp_api', version: sql`${messageDrafts.version} + 1` }).where(eq(messageDrafts.id, d.id));
      return { outcome: 'done' as const, error: null };
    }
    if (result.kind === 'unknown') {
      await createTask(tx, ctx, {
        branchId: d.branchId,
        type: 'reconcile_delivery',
        title: 'Provider did not confirm a message: check delivery before re-sending',
        entityType: 'message_draft',
        entityId: d.id,
        priority: 'high',
        dedupeKey: `reconcile:${d.id}`,
      });
      return { outcome: 'manual_required' as const, error: result.detail };
    }
    if (result.retryable && e.attempts < RETRY_MINUTES.length) {
      await tx.update(messageDrafts).set({ state: 'queued', version: sql`${messageDrafts.version} + 1` }).where(and(eq(messageDrafts.id, d.id), eq(messageDrafts.state, 'delivery_unknown')));
      return { outcome: 'retry' as const, error: result.error };
    }
    await tx.update(messageDrafts).set({ state: 'failed', version: sql`${messageDrafts.version} + 1` }).where(eq(messageDrafts.id, d.id));
    await createTask(tx, ctx, {
      branchId: d.branchId,
      type: 'message_failed',
      title: 'A message could not be sent automatically: send it manually and record it',
      entityType: 'message_draft',
      entityId: d.id,
      priority: 'urgent',
      dedupeKey: `failed:${d.id}`,
    });
    return { outcome: 'failed' as const, error: result.error };
  });
}

/**
 * Claim and process due outbox events. Returns per-event outcomes for logging and tests.
 * Events with no external effect today (JoinedUp is a manual queue) complete as "done".
 */
export async function processOutbox(db: Db, adapters: OutboxAdapters, opts: { limit?: number; now?: () => Date } = {}): Promise<{ id: string; eventType: string; outcome: OutboxOutcome }[]> {
  const now = opts.now ?? (() => new Date());
  const claimed = (await db.execute(sql`select * from app.claim_outbox(${opts.limit ?? 20})`)).rows as unknown as ClaimedEvent[];
  const results: { id: string; eventType: string; outcome: OutboxOutcome }[] = [];
  for (const e of claimed) {
    const actor = await systemActor(db, e.organisation_id);
    const ctx: ServiceContext = { db, actor, now, requestId: `outbox:${e.id}` };
    let outcome: OutboxOutcome = 'done';
    let error: string | null = null;
    try {
      if (e.event_type === 'message.dispatch') ({ outcome, error } = await dispatchMessage(ctx, adapters, e));
    } catch (err) {
      outcome = e.attempts < RETRY_MINUTES.length ? 'retry' : 'failed';
      error = err instanceof Error ? err.message : String(err);
    }
    await finish(db, actor, e, outcome, error, now());
    results.push({ id: e.id, eventType: e.event_type, outcome });
  }
  return results;
}

/** Make events abandoned by a crashed worker claimable again. */
export async function releaseStuckOutbox(db: Db, olderThanMinutes = 10): Promise<number> {
  const res = await db.execute(sql`select app.release_stuck_outbox(make_interval(mins => ${olderThanMinutes})) as n`);
  return Number((res.rows[0] as { n: number }).n);
}
