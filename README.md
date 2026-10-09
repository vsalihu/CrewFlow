# CDS Operations

Internal operations application for a labour agency: turn changing client requests into accurate worker assignments, explicit transport plans, confirmed communications and reconcilable records. Built from the _CDS Labour Operations System build plan_ (v1.0, 8 October 2026).

**Status:** Phase 0 and the first complete Phase 1 workflow are built and proven against real PostgreSQL with synthetic data. It is **not** production-ready: business policies, real data migration, Supabase/Render provisioning, backups and pilot training are open (see [docs/acceptance-tests.md](docs/acceptance-tests.md) and [docs/decisions.md](docs/decisions.md)).

## What works today

- **Intake:** pasted messages, phone notes and pasted emails are kept exactly as received, beside the structured order. Incomplete requests can be saved; nothing gets a default site or start time.
- **Orders:** multi-line orders (site, role, start time per line), immutable revisions, a signed impact preview before every amendment, source conflicts that block instructions until resolved, agency acceptance kept separate from the client request, and scoped cancellation.
- **Staffing:** a candidate list with every exclusion explained (readiness, availability, skills, clashes). Proposals are checked against the accepted count under a lock; a database constraint makes double-booking a worker impossible. Worker replies are bound to the shift version, so a stale "yes" does not confirm a changed shift.
- **Transport:** only explicit driver records can drive (`OWN` is kept as written and never interpreted). Journeys have immutable route/manifest revisions with per-segment capacity, private travel parties, verified destinations and timing checks. Driver acceptance is bound to a revision, and publishing is gated on it. Disruptions and return pickups create owned tasks.
- **Communications:** recipient-specific drafts tied to a revision. Copied, manually sent, provider-accepted, delivered and acknowledged are separate states. A change withdraws unsent drafts and creates follow-up tasks for anyone already told.
- **Operations board:** today/tomorrow per branch, with explicit blockers per line and the next concrete action, plus the return queue, tasks with recorded outcomes, duty-based ownership of late orders, and handover with acknowledgement.
- **JoinedUp:** a manual entry and verification queue; JoinedUp stays the system of record.
- **Integrations:** an honest status screen. WhatsApp, email and AI are disabled or manual, and every workflow works without them.
- **Security:** organisation and branch row-level security for a non-owner runtime role, append-only audit and revisions, idempotency keys, optimistic concurrency, and capability-based permissions.

## Quick start (local, synthetic data only)

Requirements: Node 22.12+ (24 LTS is the deployment target), pnpm 10, PostgreSQL 16 or 17.

```bash
pnpm install
cp .env.example apps/web/.env.local     # then fill in local values
createdb cds_dev
DATABASE_MIGRATION_URL=postgresql://postgres:…@localhost:5432/cds_dev pnpm db:migrate
psql …/cds_dev -c "alter role cds_app login password 'cds_app_local'"
DATABASE_MIGRATION_URL=…/cds_dev DATABASE_URL=postgresql://cds_app:cds_app_local@localhost:5432/cds_dev pnpm db:seed
pnpm dev            # http://localhost:3000, sign in as a synthetic staff member (DEV_AUTH=true)
pnpm worker         # background worker (outbox, scheduled jobs)
```

## Checks

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test                    # domain, database, RLS and concurrency tests on real PostgreSQL
pnpm build && pnpm test:e2e  # Playwright coordinator journeys
```

Tests create a migrated template database and clone it per test file (`TEST_DATABASE_URL`, default `postgresql://postgres:postgres@localhost:5432/postgres`). Domain code in tests connects as `cds_app`, so RLS applies exactly as in production.

## Layout

```text
apps/web          Next.js routes, screens and /api/v1 handlers (no business rules)
apps/worker       outbox processor and pg-boss scheduled jobs
packages/contracts  Zod command schemas, enums, error codes, capabilities, time handling
packages/db       Drizzle schema, reviewed SQL migrations (RLS, grants, exclusion constraints)
packages/auth     identity verification and capability checks
packages/domain   order, assignment, transport, messaging, outbox and board services
packages/integrations  adapter contracts and honest status
packages/test-fixtures synthetic organisation, test databases, seed script
docs/             architecture, decisions, permissions, runbooks, acceptance tests
```

## Documentation

[Architecture](docs/architecture.md) · [Decisions and open questions](docs/decisions.md) · [Acceptance tests and progress](docs/acceptance-tests.md) · [Permissions](docs/permissions.md) · [Data dictionary](docs/data-dictionary.md) · [Integration matrix](docs/integration-matrix.md) · [Operations runbook](docs/operations-runbook.md) · [Deployment](docs/deployment.md) · [Backup and restore](docs/backup-restore.md) · [Dependencies](docs/dependencies.md) · [Design](DESIGN.md)

All people, companies, phone numbers and identifiers in this repository are fictional. Do not commit real chat exports, worker data, bank details or credentials.
