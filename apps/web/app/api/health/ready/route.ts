import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Ready to serve: the database is reachable and migrations have been applied.
export async function GET() {
  try {
    await db().execute(sql`select 1 from app.organisations limit 0`);
    return Response.json({ status: 'ready' });
  } catch {
    return Response.json({ status: 'not_ready', reason: 'database unavailable' }, { status: 503 });
  }
}
