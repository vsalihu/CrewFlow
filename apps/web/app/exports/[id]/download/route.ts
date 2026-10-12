import { NextResponse, type NextRequest } from 'next/server';
import { isDomainError } from '@cds/contracts';
import { readExportFile } from '@cds/domain';
import { db } from '@/lib/db';
import { currentActor } from '@/lib/session';

export const dynamic = 'force-dynamic';

// Serves the stored export file byte-for-byte. Each download is audited by readExportFile.
export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (!actor) return new NextResponse('Sign in to continue.', { status: 401 });
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return new NextResponse('Not found.', { status: 404 });
  try {
    const f = await readExportFile({ db: db(), actor, requestId: crypto.randomUUID() }, id);
    return new NextResponse(f.content, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${f.filename}"`,
        'x-content-sha256': f.checksum,
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    // Do not reveal whether an export the actor cannot see exists.
    if (isDomainError(e) && (e.code === 'NOT_FOUND' || e.code === 'PERMISSION_DENIED')) return new NextResponse('Not found.', { status: 404 });
    throw e;
  }
}
