import { route } from '@/lib/api';
import { proposeAssignments } from '@cds/domain';
import { proposeAssignmentsSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body, idempotencyKey }) => proposeAssignments(ctx, params.id, proposeAssignmentsSchema.parse(body), idempotencyKey), { status: 201 });
