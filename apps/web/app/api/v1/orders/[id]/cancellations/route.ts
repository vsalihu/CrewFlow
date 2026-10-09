import { route } from '@/lib/api';
import { cancelOrder } from '@cds/domain';
import { cancellationSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body, idempotencyKey }) =>
  cancelOrder(ctx, params.id, cancellationSchema.parse(body), idempotencyKey),
);
