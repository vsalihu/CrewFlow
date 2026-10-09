import { route } from '@/lib/api';
import { createOrder } from '@cds/domain';
import { createOrderSchema } from '@cds/contracts';

export const POST = route(async ({ ctx, body, idempotencyKey }) => createOrder(ctx, createOrderSchema.parse(body), idempotencyKey), { status: 201 });
