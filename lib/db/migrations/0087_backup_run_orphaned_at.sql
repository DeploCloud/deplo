-- When a run's target went away, as distinct from when the backup was taken.
--
-- The orphan sweep measured its keep window from `started_at`, which is the
-- wrong clock entirely: an app deleted TODAY whose backups are two months old
-- was already past the window, so "keep the backup files" - the default, and an
-- explicit choice - meant they were gone on the next daily sweep. Applying that
-- rule to an existing instance would have deleted every artifact whose target
-- was already gone, as a side effect of an upgrade.
--
-- The sweep now stamps this column the FIRST time it sees a run orphaned, and
-- only deletes once the stamp is old enough. That covers every path a target can
-- disappear through, including the FK cascades nothing in the app drives - and
-- on the first tick after this migration every existing orphan is simply
-- stamped, so nothing is deleted for a full window.

ALTER TABLE "backup_runs" ADD COLUMN IF NOT EXISTS "orphaned_at" timestamptz;
--> statement-breakpoint

-- Partial index: the sweep asks only for rows whose target is already gone, and
-- on any real instance that is a tiny slice of the history.
CREATE INDEX IF NOT EXISTS "backup_runs_orphaned_idx"
  ON "backup_runs" ("orphaned_at")
  WHERE "app_id" IS NULL AND "database_id" IS NULL;
