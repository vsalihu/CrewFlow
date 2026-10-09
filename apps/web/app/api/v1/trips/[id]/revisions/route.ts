import { route } from '@/lib/api';
import { reviseTrip } from '@cds/domain';
import { reviseTripSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body, idempotencyKey }) => reviseTrip(ctx, params.id, reviseTripSchema.parse(body), idempotencyKey));
