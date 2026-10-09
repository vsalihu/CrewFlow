import { route } from '@/lib/api';
import { getOrderDetail } from '@cds/domain';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getOrderDetail(ctx, params.id));
