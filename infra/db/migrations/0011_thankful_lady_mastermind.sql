CREATE TABLE "hub_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_name" text NOT NULL,
	"pg_role" text NOT NULL,
	"allowed_ip" text NOT NULL,
	"hetzner_rule_ref" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_rotated_at" bigint,
	"revoked_at" bigint,
	"revoked_by" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_hub_credentials_role" ON "hub_credentials" USING btree ("pg_role");--> statement-breakpoint
CREATE INDEX "idx_hub_credentials_active" ON "hub_credentials" USING btree ("revoked_at");