import { route } from '@/lib/api';
import { generateDraft } from '@cds/domain';
import { draftMessageSchema } from '@cds/contracts';

export const POST = route(async ({ ctx, body }) => generateDraft(ctx, draftMessageSchema.parse(body)), { status: 201 });
