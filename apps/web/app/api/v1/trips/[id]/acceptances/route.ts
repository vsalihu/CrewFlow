import { route } from '@/lib/api';
import { recordTripAcceptance } from '@cds/domain';
import { tripAcceptanceSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body, idempotencyKey }) => recordTripAcceptance(ctx, params.id, tripAcceptanceSchema.parse(body), idempotencyKey));
