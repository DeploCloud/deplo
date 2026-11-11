-- An Activity entry that says a workload changed servers: what the charts mark, read as a fact and not from its wording (spec #176).
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "server_change" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- A server whose idle leader could not be uninstalled because it did not answer: asked again until it has (spec #176).
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "cluster_leader_retire_pending_at" timestamp with time zone;
--> statement-breakpoint
-- The workload a member is moving while it is emptied, as an id and a kind instead of "app:<id>" in one text (spec #176).
ALTER TABLE "cluster_members" ADD COLUMN IF NOT EXISTS "emptying_workload_kind" text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "cluster_members" SET "emptying_workload_kind" = split_part("emptying_workload", ':', 1), "emptying_workload" = split_part("emptying_workload", ':', 2) WHERE "emptying_workload" LIKE '%:%';
