import { route } from '@/lib/api';
import { createTrip } from '@cds/domain';
import { createTripSchema } from '@cds/contracts';

export const POST = route(async ({ ctx, body, idempotencyKey }) => createTrip(ctx, createTripSchema.parse(body), idempotencyKey), { status: 201 });
