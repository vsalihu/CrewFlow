import { z } from 'zod';
import { route } from '@/lib/api';
import { operationsBoard } from '@cds/domain';

const schema = z.object({ branchId: z.uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
export const GET = route(async ({ ctx, req }) => operationsBoard(ctx, schema.parse(Object.fromEntries(req.nextUrl.searchParams))));
