import { route } from '@/lib/api';
import { resolveConflict } from '@cds/domain';
import { resolveConflictSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => resolveConflict(ctx, params.id, resolveConflictSchema.parse(body)));
