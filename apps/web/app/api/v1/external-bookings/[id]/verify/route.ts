import { route } from '@/lib/api';
import { updateExternalBooking } from '@cds/domain';
import { externalBookingUpdateSchema } from '@cds/contracts';

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => updateExternalBooking(ctx, params.id, externalBookingUpdateSchema.parse(body)));
