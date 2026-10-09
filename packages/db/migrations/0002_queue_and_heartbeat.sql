-- Hand-written: background-job infrastructure (build plan §15.1, §20, §22.3).
--
-- pg-boss installs its own tables. It runs as the runtime role, which may create objects only in
-- this dedicated schema, so the queue never needs database-wide CREATE or owner credentials.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION cds_app;
--> statement-breakpoint
-- Worker liveness for monitoring ("no worker heartbeat for two minutes" alert). Not
-- organisation data, so it carries no organisation_id and no row-level policy.
CREATE TABLE IF NOT EXISTS app.worker_heartbeats (
  worker_name text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  version text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.worker_heartbeats TO cds_app;
