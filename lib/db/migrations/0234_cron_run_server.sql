-- The server a cron run was launched on, so a run is judged where it started once its App moved (spec #176).
ALTER TABLE "cron_runs" ADD COLUMN IF NOT EXISTS "server_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
