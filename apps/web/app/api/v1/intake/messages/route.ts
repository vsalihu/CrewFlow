import { captureSchema } from '../schemas';
import { route } from '@/lib/api';
import { captureSource } from '@cds/domain';

export const POST = route(async ({ ctx, body, idempotencyKey }) => captureSource(ctx, captureSchema('pasted_message', body), idempotencyKey), { status: 201 });
