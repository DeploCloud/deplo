-- A panel's token reads ONE team, so bringing several over is several runs on the
-- same machines. A run that is not the last of the series keeps their agents.
ALTER TABLE "migration_runs" ADD COLUMN IF NOT EXISTS "keep_sources" boolean DEFAULT false NOT NULL;
