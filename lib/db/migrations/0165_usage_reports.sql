-- ADR-0033: one anonymous Usage report a day, on by default, keyed by an id that is
-- re-minted whenever the switch goes from off to on.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "usage_reports_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "usage_instance_id" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "usage_instance_id_minted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "usage_report_sent_at" timestamp with time zone;
