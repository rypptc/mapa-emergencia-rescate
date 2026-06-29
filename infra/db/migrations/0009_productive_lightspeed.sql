CREATE TABLE "patient_import_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"import_id" text NOT NULL,
	"row_index" integer NOT NULL,
	"source_hospital" text DEFAULT '' NOT NULL,
	"hospital_id" text,
	"name" text DEFAULT '' NOT NULL,
	"normalized_key" text DEFAULT '' NOT NULL,
	"age" integer,
	"condition" text,
	"status" text,
	"raw_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedup_status" text DEFAULT 'pending' NOT NULL,
	"dedup_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"row_status" text DEFAULT 'pending' NOT NULL,
	"patient_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'api' NOT NULL,
	"content_type" text DEFAULT 'application/json' NOT NULL,
	"job_id" text,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"invalid_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"review_rows" integer DEFAULT 0 NOT NULL,
	"applied_rows" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"error_summary" text,
	"created_at" bigint NOT NULL,
	"processed_at" bigint,
	"applied_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient_import_rows" ADD CONSTRAINT "patient_import_rows_import_id_patient_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."patient_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_patient_import_rows_import" ON "patient_import_rows" USING btree ("import_id","row_index");--> statement-breakpoint
CREATE INDEX "idx_patient_import_rows_status" ON "patient_import_rows" USING btree ("import_id","row_status");--> statement-breakpoint
CREATE INDEX "idx_patient_imports_status" ON "patient_imports" USING btree ("status","created_at" DESC NULLS LAST);