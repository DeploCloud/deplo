-- What a team was told about an App that stopped answering, so a restart of Deplo forgets nothing (spec #176, #183).
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "unresponsive_alerted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "recovery_alert_owed" boolean DEFAULT false NOT NULL;
