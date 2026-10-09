import { route } from '@/lib/api';
import { completeTask } from '@cds/domain';
import { taskOutcomeSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body, idempotencyKey }) =>
  completeTask(ctx, { taskId: params.id, ...taskOutcomeSchema.parse(body), idempotencyKey }),
);
