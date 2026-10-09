import { route } from '@/lib/api';
import { raiseConflict } from '@cds/domain';
import { raiseConflictSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => raiseConflict(ctx, params.id, raiseConflictSchema.parse(body)), { status: 201 });
