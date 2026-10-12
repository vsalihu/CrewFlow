-- Hand-written: row-level security and grants for attendance and exports (build plan §10, §16.3).
--
-- Reported work and exported files are evidence. The runtime role can add rows but cannot change
-- recorded times, minutes or file contents. Column-level UPDATE grants allow only the state
-- transitions the application needs (marking a segment revision superseded, acknowledging an export).
ALTER TABLE app.break_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.timesheet_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.attendance_segments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.attendance_approvals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.export_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.export_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.break_policies TO cds_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.timesheet_batches TO cds_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.attendance_segments TO cds_app;
--> statement-breakpoint
GRANT UPDATE (is_current, superseded_at) ON app.attendance_segments TO cds_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.attendance_approvals TO cds_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.export_batches TO cds_app;
--> statement-breakpoint
GRANT UPDATE (state, acknowledged_at, acknowledged_by, acknowledgement_reference) ON app.export_batches TO cds_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.export_rows TO cds_app;
--> statement-breakpoint
CREATE POLICY org_scope ON app.break_policies FOR ALL TO cds_app
  USING (organisation_id = app.current_org()) WITH CHECK (organisation_id = app.current_org());
--> statement-breakpoint
CREATE POLICY branch_scope ON app.timesheet_batches FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.attendance_segments FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
CREATE POLICY branch_scope ON app.export_batches FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()))
  WITH CHECK (organisation_id = app.current_org() AND branch_id = ANY (app.current_branches()));
--> statement-breakpoint
-- attendance_approvals and export_rows: visible only when the parent row is visible.
CREATE POLICY parent_scope ON app.attendance_approvals FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.timesheet_batches p WHERE p.id = batch_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.timesheet_batches p WHERE p.id = batch_id));
--> statement-breakpoint
CREATE POLICY parent_scope ON app.export_rows FOR ALL TO cds_app
  USING (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.export_batches p WHERE p.id = export_batch_id))
  WITH CHECK (organisation_id = app.current_org() AND EXISTS (SELECT 1 FROM app.export_batches p WHERE p.id = export_batch_id));
