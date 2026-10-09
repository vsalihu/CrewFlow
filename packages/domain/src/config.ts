// Runtime secrets for domain services. Validated on first use; production refuses to run
// with the development fallback.

const DEV_FALLBACK = 'development-only-impact-token-secret';

export function impactTokenSecret(): string {
  const v = process.env.APP_SECRET;
  if (v && v.length >= 32) return v;
  if (process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging') {
    throw new Error('APP_SECRET must be set (at least 32 characters) in staging and production.');
  }
  return DEV_FALLBACK;
}
