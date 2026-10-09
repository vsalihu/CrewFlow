import { createServerClient } from '@supabase/ssr';

export type CookieAdapter = {
  getAll(): { name: string; value: string }[];
  setAll?(cookies: { name: string; value: string; options?: Record<string, unknown> }[]): void;
};

/**
 * Verify the Supabase session server-side and return the auth user id, or null.
 * Uses getClaims(), which validates the JWT signature, rather than trusting decoded
 * cookie contents. Roles and organisation come from the application database, never
 * from token metadata or browser state.
 */
export async function getVerifiedAuthUserId(opts: { url: string; publishableKey: string; cookies: CookieAdapter }): Promise<string | null> {
  const client = createServerClient(opts.url, opts.publishableKey, {
    cookies: {
      getAll: () => opts.cookies.getAll(),
      setAll: (cookies) => opts.cookies.setAll?.(cookies),
    },
  });
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return String(data.claims.sub);
}
