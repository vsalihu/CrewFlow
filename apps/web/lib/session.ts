import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getVerifiedAuthUserId, resolveStaffActor, type StaffActor } from '@cds/auth';
import { isDomainError } from '@cds/contracts';
import type { ServiceContext } from '@cds/domain';
import { db } from './db';
import { devAuthEnabled, env } from './env';

export const DEV_COOKIE = 'cds_dev_user';

/** Verified auth user id: Supabase session, or the development-only synthetic sign-in. */
async function authUserId(): Promise<string | null> {
  const jar = await cookies();
  const e = env();
  if (e.SUPABASE_URL && e.SUPABASE_PUBLISHABLE_KEY) {
    const id = await getVerifiedAuthUserId({
      url: e.SUPABASE_URL,
      publishableKey: e.SUPABASE_PUBLISHABLE_KEY,
      cookies: {
        getAll: () => jar.getAll(),
        setAll: (cs) => {
          try {
            for (const c of cs) jar.set(c.name, c.value, c.options);
          } catch {
            // Server components cannot set cookies; middleware refreshes the session.
          }
        },
      },
    });
    if (id) return id;
  }
  if (devAuthEnabled()) return jar.get(DEV_COOKIE)?.value ?? null;
  return null;
}

export async function currentActor(): Promise<StaffActor | null> {
  const id = await authUserId();
  if (!id) return null;
  try {
    return await resolveStaffActor(db(), id);
  } catch (e) {
    if (isDomainError(e)) return null;
    throw e;
  }
}

/** For pages and server actions: the signed-in staff member's service context, or a redirect. */
export async function requireContext(): Promise<ServiceContext> {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  return { db: db(), actor, requestId: crypto.randomUUID() };
}
