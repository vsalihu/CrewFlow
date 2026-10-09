import { route } from '@/lib/api';
import { decideAcceptance } from '@cds/domain';
import { acceptanceSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body, idempotencyKey }) =>
  decideAcceptance(ctx, params.id, acceptanceSchema.parse(body), idempotencyKey),
);
