ALTER TABLE "cluster_zone_states" ADD COLUMN "geo_sha256" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "geo_latitude" double precision;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "geo_longitude" double precision;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "geo_place" text;