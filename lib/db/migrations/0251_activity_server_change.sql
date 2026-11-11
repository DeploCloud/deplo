-- An Activity entry that says a workload changed servers: what the charts mark, read as a fact and not from its wording (spec #176).
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "server_change" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- A server whose idle leader could not be uninstalled because it did not answer: asked again until it has (spec #176).
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "cluster_leader_retire_pending_at" timestamp with time zone;
