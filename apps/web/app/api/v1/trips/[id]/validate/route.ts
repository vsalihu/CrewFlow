import { route } from '@/lib/api';
import { validateTrip } from '@cds/domain';

export const POST = route<{ id: string }>(async ({ ctx, params }) => validateTrip(ctx, params.id));
