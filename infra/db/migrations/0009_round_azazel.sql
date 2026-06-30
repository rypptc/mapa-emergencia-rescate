CREATE TABLE "earthquakes" (
	"id" text PRIMARY KEY NOT NULL,
	"magnitude" double precision,
	"place" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"depth_km" double precision,
	"alert" text,
	"tsunami" boolean DEFAULT false NOT NULL,
	"sig" integer,
	"usgs_updated_at" bigint NOT NULL,
	"occurred_at" bigint NOT NULL,
	"fetched_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_earthquakes_occurred" ON "earthquakes" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_earthquakes_geo" ON "earthquakes" USING btree ("lat","lng");