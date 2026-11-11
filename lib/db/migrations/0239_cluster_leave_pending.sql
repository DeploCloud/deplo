-- A server that left its cluster while its agent did not answer is told again until it has heard (spec #176).
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "cluster_leave_pending_at" timestamp with time zone;
