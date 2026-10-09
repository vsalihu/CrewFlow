import { z } from 'zod';
import { route } from '@/lib/api';
import { publishTrip } from '@cds/domain';

const schema = z.strictObject({ expectedVersion: z.number().int().min(1) });
export const POST = route<{ id: string }>(async ({ ctx, params, body, idempotencyKey }) =>
  publishTrip(ctx, params.id, schema.parse(body).expectedVersion, idempotencyKey),
);
