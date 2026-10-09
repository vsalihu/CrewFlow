import { z } from 'zod';

// Configuration is validated on first use. Disabled integrations need no credentials.
// Only truly public values may use a NEXT_PUBLIC_ prefix; none are needed today.

const schema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_BASE_URL: z.string().url().optional(),
    APP_SECRET: z.string().min(32).optional(),
    DATABASE_URL: z.string().min(1),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
    /** Development-only sign-in as a seeded synthetic staff member. Refused outside development/test. */
    DEV_AUTH: z.enum(['true', 'false']).default('false'),
  })
  .superRefine((e, ctx) => {
    const deployed = e.APP_ENV === 'staging' || e.APP_ENV === 'production';
    if (deployed && e.DEV_AUTH === 'true') ctx.addIssue({ code: 'custom', message: 'DEV_AUTH must not be enabled in staging or production' });
    if (deployed && (!e.SUPABASE_URL || !e.SUPABASE_PUBLISHABLE_KEY)) ctx.addIssue({ code: 'custom', message: 'Supabase Auth must be configured in staging and production' });
    if (deployed && !e.APP_SECRET) ctx.addIssue({ code: 'custom', message: 'APP_SECRET is required in staging and production' });
  });

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ')}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function devAuthEnabled(): boolean {
  const e = env();
  return e.DEV_AUTH === 'true' && (e.APP_ENV === 'development' || e.APP_ENV === 'test');
}
