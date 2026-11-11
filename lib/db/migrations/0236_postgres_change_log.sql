-- A Postgres database on a cluster archives its change log: when it last reached the destination,
-- and which schedule writes the base backup a failover replays it onto (spec #176).
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "wal_archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "base_backup" boolean DEFAULT false NOT NULL;
