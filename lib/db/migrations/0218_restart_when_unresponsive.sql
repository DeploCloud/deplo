ALTER TABLE "apps" ADD COLUMN "restart_when_unresponsive" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "restarts_paused_at" timestamp with time zone;