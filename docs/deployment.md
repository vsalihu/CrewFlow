# Deployment

Proposed hosting (build plan §15.2): Render web service and background worker in **Frankfurt**, Supabase project in **Frankfurt**. EU hosting is not itself compliance; record the organisation's residency decision before production. Use separate development, staging and production projects and secrets. Never use sleeping/free tiers for production.

## One-time setup per environment

1. **Supabase project** (Frankfurt): enable email/password auth with MFA for staff; configure SMTP in the dashboard; note the URL and publishable key. Database backups and PITR per [backup-restore.md](backup-restore.md).
2. **Migrations:** add `DATABASE_MIGRATION_URL` (owner connection) as a secret in the protected GitHub environment (`staging`/`production`, with required reviewers). Run the **Migrate database** workflow.
3. **Runtime role:** as the owner, run `ALTER ROLE cds_app WITH LOGIN PASSWORD '<generated secret>';`. Build `DATABASE_URL` with this role. It must not be the owner and must not have BYPASSRLS.
4. **Render:** create from `render.yaml`. In the `cds-operations-runtime` env group set `DATABASE_URL`, `APP_SECRET` (32+ random characters), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `ERROR_MONITORING_DSN`. Set `APP_ENV` per service. Do **not** set `DATABASE_MIGRATION_URL` or `DEV_AUTH` on Render.
5. **First users:** create the auth user in Supabase, then insert the membership and branch roles (an admin screen is on the backlog). Remove leavers' memberships and revoke their sessions.

## Release

1. CI green on the pull request (lint, format, typecheck, real-Postgres tests, build, Playwright, audit, secret scan).
2. Run **Migrate database** for staging; deploy the staging web and worker (auto-deploy is off). Smoke test with synthetic data.
3. Run **Migrate database** for production (expand/contract migrations only; no destructive resets), then deploy. The workflow summary records commit, environment, time and approver.
4. Roll back by redeploying the previous image; migrations are written to stay compatible with the previous release.

## Startup validation

The web app refuses to start in staging or production without Supabase settings and `APP_SECRET`, or with `DEV_AUTH=true`. Health: `/api/health/live` (process) and `/api/health/ready` (database reachable, migrations applied).
