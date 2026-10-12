CREATE TABLE "app"."attendance_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"batch_version" integer NOT NULL,
	"decision" text NOT NULL,
	"segments" jsonb NOT NULL,
	"discrepancies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_decision_valid" CHECK ("app"."attendance_approvals"."decision" in ('approved','disputed'))
);
--> statement-breakpoint
CREATE TABLE "app"."attendance_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"segment_key" uuid NOT NULL,
	"revision" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"worker_id" uuid,
	"raw_name" text NOT NULL,
	"assignment_id" uuid,
	"site_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"start_local" time NOT NULL,
	"end_local" time NOT NULL,
	"end_day_offset" integer DEFAULT 0 NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"elapsed_minutes" integer NOT NULL,
	"unpaid_break_minutes" integer NOT NULL,
	"paid_break_minutes" integer DEFAULT 0 NOT NULL,
	"paid_minutes" integer NOT NULL,
	"break_basis" text NOT NULL,
	"break_policy_id" uuid,
	"note" text,
	"reason" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "attendance_segments_organisationId_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "attendance_segments_segmentKey_revision_unique" UNIQUE("segment_key","revision"),
	CONSTRAINT "segment_status_valid" CHECK ("app"."attendance_segments"."status" in ('active','voided')),
	CONSTRAINT "segment_times" CHECK ("app"."attendance_segments"."end_at" > "app"."attendance_segments"."start_at"),
	CONSTRAINT "segment_minutes" CHECK ("app"."attendance_segments"."elapsed_minutes" > 0 and "app"."attendance_segments"."unpaid_break_minutes" >= 0 and "app"."attendance_segments"."paid_break_minutes" >= 0 and "app"."attendance_segments"."unpaid_break_minutes" <= "app"."attendance_segments"."elapsed_minutes" and "app"."attendance_segments"."paid_minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."break_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"site_id" uuid,
	"policy_version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"unpaid_break_minutes" integer NOT NULL,
	"unpaid_after_minutes" integer DEFAULT 0 NOT NULL,
	"paid_break_minutes" integer DEFAULT 0 NOT NULL,
	"agreement_reference" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "break_policies_organisationId_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "break_policy_minutes" CHECK ("app"."break_policies"."unpaid_break_minutes" >= 0 and "app"."break_policies"."unpaid_after_minutes" >= 0 and "app"."break_policies"."paid_break_minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."export_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"kind" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"format" text NOT NULL,
	"content" text NOT NULL,
	"checksum" text NOT NULL,
	"row_count" integer NOT NULL,
	"destination" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'generated' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"acknowledgement_reference" text,
	CONSTRAINT "export_batches_organisationId_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "export_batches_organisationId_reference_unique" UNIQUE("organisation_id","reference"),
	CONSTRAINT "export_kind_valid" CHECK ("app"."export_batches"."kind" in ('hours','correction')),
	CONSTRAINT "export_state_valid" CHECK ("app"."export_batches"."state" in ('generated','acknowledged'))
);
--> statement-breakpoint
CREATE TABLE "app"."export_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"export_batch_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"segment_key" uuid NOT NULL,
	"segment_revision" integer NOT NULL,
	"row_type" text NOT NULL,
	"paid_minutes" integer NOT NULL,
	CONSTRAINT "export_rows_segmentId_rowType_unique" UNIQUE("segment_id","row_type"),
	CONSTRAINT "export_row_type_valid" CHECK ("app"."export_rows"."row_type" in ('hours','reversal'))
);
--> statement-breakpoint
CREATE TABLE "app"."timesheet_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"reference" text NOT NULL,
	"supervisor_name" text NOT NULL,
	"source_message_id" uuid NOT NULL,
	"state" text DEFAULT 'submitted' NOT NULL,
	"recorded_by" uuid NOT NULL,
	"dispute_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "timesheet_batches_organisationId_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "timesheet_batches_organisationId_reference_unique" UNIQUE("organisation_id","reference"),
	CONSTRAINT "timesheet_state_valid" CHECK ("app"."timesheet_batches"."state" in ('submitted','approved','disputed'))
);
--> statement-breakpoint
ALTER TABLE "app"."attendance_approvals" ADD CONSTRAINT "attendance_approvals_organisation_id_batch_id_timesheet_batches_organisation_id_id_fk" FOREIGN KEY ("organisation_id","batch_id") REFERENCES "app"."timesheet_batches"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."attendance_segments" ADD CONSTRAINT "attendance_segments_organisation_id_batch_id_timesheet_batches_organisation_id_id_fk" FOREIGN KEY ("organisation_id","batch_id") REFERENCES "app"."timesheet_batches"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."attendance_segments" ADD CONSTRAINT "attendance_segments_organisation_id_worker_id_workers_organisation_id_id_fk" FOREIGN KEY ("organisation_id","worker_id") REFERENCES "app"."workers"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."attendance_segments" ADD CONSTRAINT "attendance_segments_organisation_id_assignment_id_assignments_organisation_id_id_fk" FOREIGN KEY ("organisation_id","assignment_id") REFERENCES "app"."assignments"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."break_policies" ADD CONSTRAINT "break_policies_organisation_id_client_id_clients_organisation_id_id_fk" FOREIGN KEY ("organisation_id","client_id") REFERENCES "app"."clients"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."export_batches" ADD CONSTRAINT "export_batches_organisation_id_branch_id_branches_organisation_id_id_fk" FOREIGN KEY ("organisation_id","branch_id") REFERENCES "app"."branches"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."export_rows" ADD CONSTRAINT "export_rows_organisation_id_export_batch_id_export_batches_organisation_id_id_fk" FOREIGN KEY ("organisation_id","export_batch_id") REFERENCES "app"."export_batches"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."export_rows" ADD CONSTRAINT "export_rows_organisation_id_segment_id_attendance_segments_organisation_id_id_fk" FOREIGN KEY ("organisation_id","segment_id") REFERENCES "app"."attendance_segments"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."timesheet_batches" ADD CONSTRAINT "timesheet_batches_organisation_id_branch_id_branches_organisation_id_id_fk" FOREIGN KEY ("organisation_id","branch_id") REFERENCES "app"."branches"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."timesheet_batches" ADD CONSTRAINT "timesheet_batches_organisation_id_client_id_clients_organisation_id_id_fk" FOREIGN KEY ("organisation_id","client_id") REFERENCES "app"."clients"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."timesheet_batches" ADD CONSTRAINT "timesheet_batches_organisation_id_site_id_sites_organisation_id_id_fk" FOREIGN KEY ("organisation_id","site_id") REFERENCES "app"."sites"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."timesheet_batches" ADD CONSTRAINT "timesheet_batches_organisation_id_source_message_id_source_messages_organisation_id_id_fk" FOREIGN KEY ("organisation_id","source_message_id") REFERENCES "app"."source_messages"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_segments_one_current" ON "app"."attendance_segments" USING btree ("segment_key") WHERE is_current;--> statement-breakpoint
CREATE INDEX "attendance_segments_organisation_id_worker_id_service_date_index" ON "app"."attendance_segments" USING btree ("organisation_id","worker_id","service_date");--> statement-breakpoint
CREATE INDEX "attendance_segments_organisation_id_batch_id_index" ON "app"."attendance_segments" USING btree ("organisation_id","batch_id");--> statement-breakpoint
CREATE INDEX "break_policies_organisation_id_client_id_index" ON "app"."break_policies" USING btree ("organisation_id","client_id");--> statement-breakpoint
CREATE INDEX "timesheet_batches_organisation_id_branch_id_service_date_index" ON "app"."timesheet_batches" USING btree ("organisation_id","branch_id","service_date");