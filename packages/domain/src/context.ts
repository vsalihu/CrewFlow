import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError } from '@cds/contracts';
import { actorId, visibleBranchIds, type Actor } from '@cds/auth';
import { auditEvents, idempotencyKeys, outboxEvents, withContext, type Db, type Tx } from '@cds/db';

export type ServiceContext = {
  db: Db;
  actor: Actor;
  /** Injected clock so tests and replays are deterministic. */
  now?: () => Date;
  requestId?: string;
};

export function nowOf(ctx: ServiceContext): Date {
  return ctx.now ? ctx.now() : new Date();
}

/** Read-only work under the actor's row-level-security context. */
export function read<T>(ctx: ServiceContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(ctx.db, { organisationId: ctx.actor.organisationId, branchIds: visibleBranchIds(ctx.actor) }, fn);
}

export type CommandOptions = {
  operation: string;
  /** Required for commands from the HTTP API; replays return the stored response. */
  idempotencyKey?: string;
  input?: unknown;
};

function hashInput(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input ?? null))
    .digest('hex');
}

/**
 * Run a state-changing command in one transaction under the actor's RLS context.
 * Audit and outbox rows written inside `fn` commit or roll back with the state change.
 * With an idempotency key, a replay of the same input returns the first response and a
 * reuse with different input is rejected.
 */
export async function command<T>(ctx: ServiceContext, opts: CommandOptions, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return read(ctx, async (tx) => {
    const key = opts.idempotencyKey;
    const actor = actorId(ctx.actor) ?? '00000000-0000-0000-0000-000000000000';
    if (key) {
      const hash = hashInput(opts.input);
      await tx
        .insert(idempotencyKeys)
        .values({ organisationId: ctx.actor.organisationId, actorId: actor, operation: opts.operation, key, requestHash: hash })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.organisationId, ctx.actor.organisationId),
            eq(idempotencyKeys.actorId, actor),
            eq(idempotencyKeys.operation, opts.operation),
            eq(idempotencyKeys.key, key),
          ),
        )
        .for('update');
      if (!row) throw new Error('idempotency row missing');
      if (row.requestHash !== hash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'This request key was already used for a different request.');
      }
      if (row.response !== null) return row.response as T;
      const result = await fn(tx);
      await tx
        .update(idempotencyKeys)
        .set({ response: (result ?? null) as never })
        .where(
          and(
            eq(idempotencyKeys.organisationId, ctx.actor.organisationId),
            eq(idempotencyKeys.actorId, actor),
            eq(idempotencyKeys.operation, opts.operation),
            eq(idempotencyKeys.key, key),
          ),
        );
      return result;
    }
    return fn(tx);
  });
}

export async function audit(
  tx: Tx,
  ctx: ServiceContext,
  e: { action: string; entityType: string; entityId: string | null; before?: unknown; after?: unknown; reason?: string | null },
): Promise<void> {
  await tx.insert(auditEvents).values({
    organisationId: ctx.actor.organisationId,
    actorMembershipId: actorId(ctx.actor),
    actorSystem: ctx.actor.kind === 'system' ? ctx.actor.name : null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    before: (e.before ?? null) as never,
    after: (e.after ?? null) as never,
    reason: e.reason ?? null,
    requestId: ctx.requestId ?? null,
  });
}

/** Outbox rows carry identifiers and metadata only, never sensitive content. */
export async function enqueue(
  tx: Tx,
  ctx: ServiceContext,
  e: { eventType: string; entityType: string; entityId: string; entityRevision?: number | null; payload?: Record<string, unknown> },
): Promise<void> {
  await tx.insert(outboxEvents).values({
    organisationId: ctx.actor.organisationId,
    eventType: e.eventType,
    entityType: e.entityType,
    entityId: e.entityId,
    entityRevision: e.entityRevision ?? null,
    payload: (e.payload ?? {}) as never,
  });
}

export async function nextReference(tx: Tx, ctx: ServiceContext, name: string, prefix: string): Promise<string> {
  const res = await tx.execute(sql`
    insert into app.reference_sequences (organisation_id, name, next_value)
    values (${ctx.actor.organisationId}, ${name}, 2)
    on conflict (organisation_id, name) do update set next_value = app.reference_sequences.next_value + 1
    returning next_value - 1 as value`);
  const value = Number((res.rows[0] as { value: number }).value);
  return `${prefix}-${String(value).padStart(5, '0')}`;
}

export function notFound(what: string): DomainError {
  return new DomainError('NOT_FOUND', `${what} not found.`);
}

export function checkVersion(current: number, expected: number | undefined): void {
  if (expected !== undefined && expected !== current) {
    throw new DomainError('VERSION_CONFLICT', 'Someone else changed this record. Reload and try again.', { currentVersion: current });
  }
}

/** Map PostgreSQL constraint errors that represent business conflicts to domain errors. */
export function translateDbError(e: unknown): never {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = err.code ?? err.cause?.code;
  const constraint = err.constraint ?? err.cause?.constraint;
  if (code === '23P01') {
    throw new DomainError('RESOURCE_CONFLICT', 'This person or vehicle is already booked for an overlapping time.');
  }
  if (code === '23505' && constraint === 'assignments_one_active_per_line_worker') {
    throw new DomainError('VALIDATION_FAILED', 'This worker is already on this shift line.');
  }
  throw e;
}

export function pgErrorCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code ?? err.cause?.code;
}
