import { route } from '@/lib/api';
import { amendOrder } from '@cds/domain';
import { amendmentSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body, idempotencyKey }) =>
  amendOrder(ctx, params.id, amendmentSchema.parse(body), idempotencyKey),
);
