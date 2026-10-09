import { z } from 'zod';
import { route } from '@/lib/api';
import { reportTripDisruption } from '@cds/domain';

const schema = z.strictObject({ kind: z.enum(['breakdown', 'driver_cancelled', 'delay', 'other']), note: z.string().trim().min(1).max(2000) });
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => reportTripDisruption(ctx, params.id, schema.parse(body)), { status: 201 });
