import { z } from 'zod';
import { route } from '@/lib/api';
import { queueProviderSend } from '@cds/domain';

const schema = z.strictObject({ expectedVersion: z.number().int().min(1) });
/** Refused with INTEGRATION_DISABLED until a messaging provider is verified and enabled. */
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => queueProviderSend(ctx, params.id, schema.parse(body).expectedVersion), { status: 202 });
