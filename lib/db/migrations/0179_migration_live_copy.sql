ALTER TABLE "migration_runs" ADD COLUMN IF NOT EXISTS "live_copy" boolean DEFAULT false NOT NULL;
