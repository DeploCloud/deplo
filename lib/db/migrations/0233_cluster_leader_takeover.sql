-- A leader on another server (spec #176): since when Deplo's own machine leads in its place, and whose Activity says so.
ALTER TABLE "clusters" ADD COLUMN IF NOT EXISTS "leader_takeover_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN IF NOT EXISTS "leader_team_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clusters" ADD CONSTRAINT "clusters_leader_team_id_teams_id_fk" FOREIGN KEY ("leader_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
