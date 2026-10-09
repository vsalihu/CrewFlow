-- Hand-written security migration (build plan §16.3, §21.1). Reviewed; not generated.
--
-- * cds_app is the runtime role used by the web app and background worker. It does not
--   own any table and has no BYPASSRLS, so row-level security always applies to it.
--   The role is NOLOGIN here; operators grant LOGIN with a secret password per
--   environment (docs/deployment.md). Migration credentials are never given to runtime.
-- * Request context is set transaction-locally by the application after authentication:
--     set_config('app.organisation_id', <uuid>, true)
--     set_config('app.branch_ids', '{<uuid>,...}', true)
--   With no context set, every policy evaluates to false and no rows are visible.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cds_app') THEN
    CREATE ROLE cds_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_org() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.organisation_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_branches() RETURNS uuid[]
  LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('app.branch_ids', true), '')::uuid[], '{}'::uuid[]) $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO cds_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_org(), app.current_branches() TO cds_app;
--> statement-breakpoint
ALTER TABLE app.organisations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.organisations TO cds_app;
--> statement-breakpoint
ALTER TABLE app.branches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.branches TO cds_app;
--> statement-breakpoint
ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.memberships TO cds_app;
--> statement-breakpoint
ALTER TABLE app.branch_memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.branch_memberships TO cds_app;
--> statement-breakpoint
ALTER TABLE app.clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.clients TO cds_app;
--> statement-breakpoint
ALTER TABLE app.client_contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.client_contacts TO cds_app;
--> statement-breakpoint
ALTER TABLE app.sites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.sites TO cds_app;
--> statement-breakpoint
ALTER TABLE app.work_locations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.work_locations TO cds_app;
--> statement-breakpoint
ALTER TABLE app.site_aliases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.site_aliases TO cds_app;
--> statement-breakpoint
ALTER TABLE app.readiness_requirements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.readiness_requirements TO cds_app;
--> statement-breakpoint
ALTER TABLE app.readiness_checks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.readiness_checks TO cds_app;
--> statement-breakpoint
ALTER TABLE app.workers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.workers TO cds_app;
--> statement-breakpoint
ALTER TABLE app.external_worker_ids ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.external_worker_ids TO cds_app;
--> statement-breakpoint
ALTER TABLE app.worker_aliases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.worker_aliases TO cds_app;
--> statement-breakpoint
ALTER TABLE app.contact_points ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.contact_points TO cds_app;
--> statement-breakpoint
ALTER TABLE app.worker_skills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.worker_skills TO cds_app;
--> statement-breakpoint
ALTER TABLE app.worker_availability ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.worker_availability TO cds_app;
--> statement-breakpoint
ALTER TABLE app.pickup_points ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.pickup_points TO cds_app;
--> statement-breakpoint
ALTER TABLE app.travel_parties ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.travel_parties TO cds_app;
--> statement-breakpoint
ALTER TABLE app.travel_party_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.travel_party_members TO cds_app;
--> statement-breakpoint
ALTER TABLE app.resource_reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.resource_reservations TO cds_app;
--> statement-breakpoint
ALTER TABLE app.outbox_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.outbox_events TO cds_app;
--> statement-breakpoint
ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.audit_events TO cds_app;
--> statement-breakpoint
ALTER TABLE app.idempotency_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.idempotency_keys TO cds_app;
--> statement-breakpoint
ALTER TABLE app.integration_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.integration_settings TO cds_app;
--> statement-breakpoint
ALTER TABLE app.reference_sequences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.reference_sequences TO cds_app;
--> statement-breakpoint
ALTER TABLE app.duty_periods ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.duty_periods TO cds_app;
--> statement-breakpoint
ALTER TABLE app.conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.conversations TO cds_app;
--> statement-breakpoint
ALTER TABLE app.source_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.source_messages TO cds_app;
--> statement-breakpoint
ALTER TABLE app.orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.orders TO cds_app;
--> statement-breakpoint
ALTER TABLE app.order_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.order_lines TO cds_app;
--> statement-breakpoint
ALTER TABLE app.assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.assignments TO cds_app;
--> statement-breakpoint
ALTER TABLE app.trips ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.trips TO cds_app;
--> statement-breakpoint
ALTER TABLE app.message_drafts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.message_drafts TO cds_app;
--> statement-breakpoint
ALTER TABLE app.external_bookings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.external_bookings TO cds_app;
--> statement-breakpoint
ALTER TABLE app.handover_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.handover_snapshots TO cds_app;
--> statement-breakpoint
ALTER TABLE app.drivers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.drivers TO cds_app;
--> statement-breakpoint
ALTER TABLE app.vehicles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.vehicles TO cds_app;
--> statement-breakpoint
ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.tasks TO cds_app;
--> statement-breakpoint
ALTER TABLE app.cases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.cases TO cds_app;
--> statement-breakpoint
ALTER TABLE app.order_revisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.order_revisions TO cds_app;
--> statement-breakpoint
ALTER TABLE app.order_source_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.order_source_links TO cds_app;
--> statement-breakpoint
ALTER TABLE app.order_conflicts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.order_conflicts TO cds_app;
--> statement-breakpoint
ALTER TABLE app.assignment_responses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.assignment_responses TO cds_app;
--> statement-breakpoint
ALTER TABLE app.transport_requirements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.transport_requirements TO cds_app;
--> statement-breakpoint
ALTER TABLE app.trip_revisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.trip_revisions TO cds_app;
--> statement-breakpoint
ALTER TABLE app.trip_acceptances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.trip_acceptances TO cds_app;
--> statement-breakpoint
ALTER TABLE app.trip_stops ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.trip_stops TO cds_app;
--> statement-breakpoint
ALTER TABLE app.trip_passengers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.trip_passengers TO cds_app;
--> statement-breakpoint
CREATE POLICY org_scope ON app.organisations FOR ALL TO cds_app
  USING (id = app.current_org()) WITH CHECK (id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.branches FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.memberships FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.branch_memberships FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.clients FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.client_contacts FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.sites FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.work_locations FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.site_aliases FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.readiness_requirements FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.readiness_checks FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.workers FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.external_worker_ids FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.worker_aliases FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.contact_points FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.worker_skills FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.worker_availability FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.pickup_points FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.travel_parties FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.travel_party_members FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.resource_reservations FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.outbox_events FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.audit_events FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.idempotency_keys FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.integration_settings FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY org_scope ON app.reference_sequences FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY branch_scope ON app.duty_periods FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.conversations FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.source_messages FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.orders FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.order_lines FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.assignments FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.trips FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.message_drafts FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.external_bookings FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.handover_snapshots FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.drivers FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.vehicles FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.tasks FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND (branch_id IS NULL OR branch_id = ANY (app.current_branches())))
  WITH CHECK (organisation_id = app.current_org() AND (branch_id IS NULL OR branch_id = ANY (app.current_branches())));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.cases FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND (branch_id IS NULL OR branch_id = ANY (app.current_branches())))
  WITH CHECK (organisation_id = app.current_org() AND (branch_id IS NULL OR branch_id = ANY (app.current_branches())));
--> statement-breakpoint
-- order_revisions: visible only when its parent orders row is visible (parent RLS applies inside EXISTS).
CREATE POLICY parent_scope ON app.order_revisions FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.orders p WHERE p.id = order_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.orders p WHERE p.id = order_id));
--> statement-breakpoint
-- order_source_links: visible only when its parent orders row is visible (parent RLS applies inside EXISTS).
CREATE POLICY parent_scope ON app.order_source_links FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.orders p WHERE p.id = order_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.orders p WHERE p.id = order_id));
--> statement-breakpoint
-- order_conflicts: visible only when its parent orders row is visible (parent RLS applies inside EXISTS).
CREATE POLICY parent_scope ON app.order_conflicts FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.orders p WHERE p.id = order_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.orders p WHERE p.id = order_id));
--> statement-breakpoint
-- assignment_responses: visible only when its parent assignments row is visible (parent RLS applies inside EXISTS).
CREATE POLICY parent_scope ON app.assignment_responses FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.assignments p WHERE p.id = assignment_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.assignments p WHERE p.id = assignment_id));
--> statement-breakpoint
-- transport_requirements: visible only when its parent assignments row is visible (parent RLS applies inside EXISTS).
CREATE POLICY parent_scope ON app.transport_requirements FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.assignments p WHERE p.id = assignment_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.assignments p WHERE p.id = assignment_id));
--> statement-breakpoint
-- trip_revisions: visible only when its parent trips row is visible (parent RLS applies inside EXISTS).
CREATE POLICY parent_scope ON app.trip_revisions FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.trips p WHERE p.id = trip_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.trips p WHERE p.id = trip_id));
--> statement-breakpoint
-- trip_acceptances: visible only when its parent trips row is visible (parent RLS applies inside EXISTS).
CREATE POLICY parent_scope ON app.trip_acceptances FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.trips p WHERE p.id = trip_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.trips p WHERE p.id = trip_id));
--> statement-breakpoint
-- trip_stops: visible only when its parent trip_revisions row is visible (parent RLS applies inside EXISTS).
CREATE POLICY parent_scope ON app.trip_stops FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.trip_revisions p WHERE p.id = trip_revision_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.trip_revisions p WHERE p.id = trip_revision_id));
--> statement-breakpoint
-- trip_passengers: visible only when its parent trip_revisions row is visible (parent RLS applies inside EXISTS).
CREATE POLICY parent_scope ON app.trip_passengers FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.trip_revisions p WHERE p.id = trip_revision_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.trip_revisions p WHERE p.id = trip_revision_id));
--> statement-breakpoint
-- Incompatible time reservations for one worker, driver or vehicle cannot both be active.
-- This is what makes two simultaneous proposals of the same worker fail safely (AT22).
ALTER TABLE app.resource_reservations
  ADD CONSTRAINT resource_reservations_no_overlap
  EXCLUDE USING gist (organisation_id WITH =, resource_type WITH =, resource_id WITH =, during WITH &&)
  WHERE (active);
--> statement-breakpoint
ALTER TABLE app.resource_reservations
  ADD CONSTRAINT resource_reservations_nonempty CHECK (NOT isempty(during) AND NOT lower_inf(during) AND NOT upper_inf(during));
--> statement-breakpoint
ALTER TABLE app.worker_availability
  ADD CONSTRAINT worker_availability_kind CHECK (kind IN ('available', 'unavailable'));
--> statement-breakpoint
-- Membership lookup happens before organisation context exists, so it is a narrow
-- SECURITY DEFINER function keyed by the verified auth user id only.
CREATE OR REPLACE FUNCTION app.resolve_memberships(p_auth_user_id uuid)
  RETURNS TABLE (membership_id uuid, organisation_id uuid, display_name text, org_roles text[], branch_id uuid, branch_roles text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
    SELECT m.id, m.organisation_id, m.display_name, m.roles, bm.branch_id, bm.roles
    FROM app.memberships m
    LEFT JOIN app.branch_memberships bm ON bm.membership_id = m.id
    WHERE m.auth_user_id = p_auth_user_id AND m.status = 'active'
  $$;
--> statement-breakpoint
-- The background worker claims due outbox events across organisations, then processes
-- each one under that event's organisation context with a recorded system actor.
CREATE OR REPLACE FUNCTION app.claim_outbox(p_limit integer)
  RETURNS TABLE (id uuid, organisation_id uuid, event_type text, entity_type text, entity_id uuid, entity_revision integer, payload jsonb, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = app, pg_temp AS $$
    UPDATE app.outbox_events e
       SET state = 'processing', attempts = e.attempts + 1, next_attempt_at = now()
     WHERE e.id IN (
       SELECT o.id FROM app.outbox_events o
        WHERE o.state = 'pending' AND o.next_attempt_at <= now()
        ORDER BY o.next_attempt_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED)
    RETURNING e.id, e.organisation_id, e.event_type, e.entity_type, e.entity_id, e.entity_revision, e.payload, e.attempts
  $$;
--> statement-breakpoint
-- Events left in 'processing' by a crashed worker become claimable again (AT47).
CREATE OR REPLACE FUNCTION app.release_stuck_outbox(p_older_than interval)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = app, pg_temp AS $$
    WITH r AS (
      UPDATE app.outbox_events SET state = 'pending', next_attempt_at = now()
       WHERE state = 'processing' AND next_attempt_at < now() - p_older_than
       RETURNING 1)
    SELECT count(*)::integer FROM r
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_memberships(uuid), app.claim_outbox(integer), app.release_stuck_outbox(interval) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_memberships(uuid), app.claim_outbox(integer), app.release_stuck_outbox(interval) TO cds_app;
