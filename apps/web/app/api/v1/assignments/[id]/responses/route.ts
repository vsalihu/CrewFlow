import { route } from '@/lib/api';
import { recordWorkerResponse } from '@cds/domain';
import { workerResponseSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body, idempotencyKey }) => recordWorkerResponse(ctx, params.id, workerResponseSchema.parse(body), idempotencyKey));
