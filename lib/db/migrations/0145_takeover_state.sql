-- Installing Deplo onto a machine another platform already owns. The installer
-- sees the other panel and Deplo cannot, so the state it hands over lives here:
-- which platform, how far the takeover has got, and whether anything but the
-- installer has ever reached this panel.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "takeover_platform" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "takeover_state" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "takeover_run_id" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "takeover_seen_external_at" timestamp with time zone;--> statement-breakpoint
-- What the data phase actually STOPPED on the other platform, so backing out can
-- start exactly those again instead of guessing from what was targeted.
ALTER TABLE "migration_run_targets" ADD COLUMN IF NOT EXISTS "stopped_kind" text;--> statement-breakpoint
ALTER TABLE "migration_run_targets" ADD COLUMN IF NOT EXISTS "stopped_at" timestamp with time zone;
