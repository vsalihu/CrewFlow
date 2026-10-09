# Dependencies

Exact versions are locked in `pnpm-lock.yaml`. Resolved at scaffolding (9 October 2026):

| Area            | Package                               | Version                                                                               |
| --------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| Runtime         | Node.js                               | 24 LTS target (`.nvmrc`, Docker `node:24-bookworm-slim`); tested on 22.22.0           |
| Package manager | pnpm                                  | 10.28.0                                                                               |
| Language        | TypeScript                            | 6.0.3 (see decision D23)                                                              |
| Web             | next / react / react-dom              | 16.4.0 / 19.3.0 / 19.3.0                                                              |
| Styling         | tailwindcss / @tailwindcss/postcss    | 4.3.3 / 4.3.3                                                                         |
| Validation      | zod                                   | 4.6.5                                                                                 |
| Time            | luxon                                 | 3.7.2                                                                                 |
| Database        | drizzle-orm / drizzle-kit / pg        | 0.45.4 / 0.31.11 / 8.23.1                                                             |
| Jobs            | pg-boss                               | 12.37.1                                                                               |
| Auth            | @supabase/ssr / @supabase/supabase-js | 0.12.7 / 2.117.3                                                                      |
| Tests           | vitest / @playwright/test             | 5.0.3 / 1.64.0                                                                        |
| Quality         | eslint / typescript-eslint / prettier | 10.12.0 / 8.71.1 / 3.9.9                                                              |
| Scripts         | tsx                                   | 4.23.15                                                                               |
| PostgreSQL      | server                                | 17 in CI (`postgres:17`); 16.15 locally. Confirm the Supabase project's major version |

Extensions required: `pgcrypto`, `btree_gist`, `pg_trgm` (installed into the `extensions` schema on Supabase).

Policy: patch updates via reviewed pull requests with CI; never canary or pre-release packages in production; `pnpm audit --prod --audit-level high` runs in CI.
