import { route } from '@/lib/api';
import { listCandidates } from '@cds/domain';

export const GET = route<{ id: string }>(async ({ ctx, params, req }) =>
  listCandidates(ctx, params.id, { search: req.nextUrl.searchParams.get('q') ?? undefined }),
);
