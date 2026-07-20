-- FK columns that are ON DELETE SET NULL but were unindexed: deleting an app (or
-- database / S3 destination) forced Postgres to sequentially scan the whole
-- `activities` / `backup_runs` history to find the referencing rows, so a delete
-- on a busy team (and the N-times-cascaded team delete) walked the entire table.
-- Index each referencing column so the cascade is a lookup, not a full scan.
--
-- Idempotent (IF NOT EXISTS) so a re-run or a concurrent boot is a no-op — the
-- boot migrator auto-applies this. Hand-authored: the committed drizzle snapshots
-- stop at 0014, so `drizzle-kit generate` can't diff against an up-to-date base.
CREATE INDEX IF NOT EXISTS "activities_app_idx" ON "activities" ("app_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_runs_app_idx" ON "backup_runs" ("app_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_runs_database_idx" ON "backup_runs" ("database_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_runs_destination_idx" ON "backup_runs" ("destination_id");
