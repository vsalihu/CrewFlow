import { route } from '@/lib/api';
import { markManuallySent } from '@cds/domain';
import { manualSentSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body, idempotencyKey }) =>
  markManuallySent(ctx, params.id, manualSentSchema.parse(body), idempotencyKey),
);
