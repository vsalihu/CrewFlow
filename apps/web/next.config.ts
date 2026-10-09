import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value:
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  },
];

const config: NextConfig = {
  transpilePackages: ['@cds/auth', '@cds/contracts', '@cds/db', '@cds/domain', '@cds/integrations'],
  serverExternalPackages: ['pg', 'pg-boss'],
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
