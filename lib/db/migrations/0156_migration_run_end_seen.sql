-- A run that ended is not owed a screen: a failed or stopped one reopened the
-- wizard on every visit, and a finished one now holds the header chip until its
-- report is closed - which must not light up for runs that ended before the chip.
UPDATE "migration_runs" SET "report_seen_at" = COALESCE("finished_at", "started_at")
  WHERE "status" <> 'running' AND "report_seen_at" IS NULL;
