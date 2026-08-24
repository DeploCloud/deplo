-- Why a migrated app's or database's data is not here, kept on the row.
--
-- A cross-host copy empties the destination volume before extracting into it, so
-- a copy that dies mid-stream does not leave the old contents behind: it leaves
-- nothing, or half of something. Until now that was recorded only as a line in
-- the import report - the run still closed as done, and pressing Deploy started
-- the app on the empty volume. An engine does not fail on an empty data
-- directory, it INITIALISES one, which is how a migration turns into data loss
-- the morning after rather than at the moment it went wrong.
--
-- Empty string is "nothing wrong", which is every row that predates this and
-- every app that was never migrated. While it is set, every way of starting the
-- workload refuses and says this sentence.
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "data_copy_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "data_copy_error" text DEFAULT '' NOT NULL;
