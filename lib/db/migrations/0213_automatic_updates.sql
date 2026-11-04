ALTER TABLE "deplo_update_log" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "auto_updates_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "auto_update_hour" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "auto_update_timezone" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "auto_update_postponed_until" timestamp with time zone;