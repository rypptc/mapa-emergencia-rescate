ALTER TABLE "patient_imports" ADD COLUMN "failed_stage" text;--> statement-breakpoint
ALTER TABLE "patient_imports" ADD COLUMN "idempotency_key_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_patient_imports_actor_idempotency" ON "patient_imports" USING btree ("created_by","idempotency_key_hash") WHERE idempotency_key_hash IS NOT NULL;
