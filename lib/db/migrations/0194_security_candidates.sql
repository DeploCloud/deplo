ALTER TABLE "workload_images" ADD COLUMN "newer_tag_digest" text;--> statement-breakpoint
ALTER TABLE "workload_images" ADD COLUMN "candidate_ref" text;--> statement-breakpoint
ALTER TABLE "workload_images" ADD COLUMN "candidate_image_id" text;--> statement-breakpoint
ALTER TABLE "workload_images" ADD COLUMN "candidate_status" text;--> statement-breakpoint
ALTER TABLE "workload_images" ADD COLUMN "candidate_checked_at" timestamp with time zone;--> statement-breakpoint
-- Ask every registry again on the next tick: the newer tag's digest is what gets read before Update.
UPDATE "workload_images" SET "registry_checked_at" = NULL;
