import { eq } from 'drizzle-orm';
import { DomainError, captureSourceSchema, type CaptureSourceInput } from '@cds/contracts';
import { actorId, requireCapability } from '@cds/auth';
import { sourceMessages } from '@cds/db';
import { audit, command, read, type ServiceContext } from './context';

/**
 * Preserve an incoming request exactly as received. A pasted WhatsApp message is
 * client-authored evidence; a phone note is staff-recorded evidence of a call, not a
 * recording, and is labelled as such. Capturing a source never creates or changes an order.
 */
export async function captureSource(ctx: ServiceContext, raw: CaptureSourceInput, idempotencyKey?: string): Promise<{ id: string }> {
  const input = captureSourceSchema.parse(raw);
  requireCapability(ctx.actor, 'source.capture', input.branchId);
  if (input.kind === 'phone_note' && !input.callerName) {
    throw new DomainError('VALIDATION_FAILED', 'Record who called.', { fieldErrors: { callerName: ['Required for phone notes.'] } });
  }
  return command(ctx, { operation: 'source.capture', idempotencyKey, input }, async (tx) => {
    const [row] = await tx
      .insert(sourceMessages)
      .values({
        organisationId: ctx.actor.organisationId,
        branchId: input.branchId,
        kind: input.kind,
        conversationId: input.conversationId ?? null,
        providerMessageId: input.providerMessageId ?? null,
        senderLabel: input.senderLabel ?? null,
        clientContactId: input.clientContactId ?? null,
        receivedAt: new Date(input.receivedAt),
        recordedBy: actorId(ctx.actor)!,
        rawText: input.rawText,
        callerName: input.callerName ?? null,
        createdBy: actorId(ctx.actor),
      })
      .returning({ id: sourceMessages.id });
    // The audit row records the capture, not the private text itself.
    await audit(tx, ctx, { action: 'source.captured', entityType: 'source_message', entityId: row!.id, after: { kind: input.kind, length: input.rawText.length } });
    return { id: row!.id };
  });
}

export async function getSource(ctx: ServiceContext, id: string) {
  requireCapability(ctx.actor, 'source.read');
  return read(ctx, async (tx) => {
    const [row] = await tx.select().from(sourceMessages).where(eq(sourceMessages.id, id));
    return row ?? null;
  });
}
