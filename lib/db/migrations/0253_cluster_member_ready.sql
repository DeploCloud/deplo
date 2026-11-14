-- A server that joins a cluster reads Provisioning until the cluster's leader answers for it.
ALTER TABLE "cluster_members" ADD COLUMN IF NOT EXISTS "ready_at" timestamp with time zone;
--> statement-breakpoint
-- Every server already in a cluster has been working there.
UPDATE "cluster_members" SET "ready_at" = "joined_at" WHERE "ready_at" IS NULL;
