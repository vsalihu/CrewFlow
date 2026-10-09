import { route } from '@/lib/api';
import { previewAmendment } from '@cds/domain';
import { amendmentSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => previewAmendment(ctx, params.id, amendmentSchema.parse(body)));
