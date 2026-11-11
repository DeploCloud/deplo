-- The control plane's place in the leader's event stream and each member's lease state (spec #176).
ALTER TABLE "clusters" ADD COLUMN IF NOT EXISTS "event_seq" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "cluster_members" ADD COLUMN IF NOT EXISTS "lease_state" text DEFAULT 'ok' NOT NULL;
--> statement-breakpoint
ALTER TABLE "cluster_members" ADD COLUMN IF NOT EXISTS "lease_changed_at" timestamp with time zone;
