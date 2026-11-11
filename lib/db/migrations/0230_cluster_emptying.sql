-- Emptying a cluster member (spec #176): why it stopped, what is moving now, how many it started with, and whose Activity it is.
ALTER TABLE "cluster_members" ADD COLUMN IF NOT EXISTS "emptying_error" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "cluster_members" ADD COLUMN IF NOT EXISTS "emptying_workload" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "cluster_members" ADD COLUMN IF NOT EXISTS "emptying_total" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "cluster_members" ADD COLUMN IF NOT EXISTS "emptying_team_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cluster_members" ADD CONSTRAINT "cluster_members_emptying_team_id_teams_id_fk" FOREIGN KEY ("emptying_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
