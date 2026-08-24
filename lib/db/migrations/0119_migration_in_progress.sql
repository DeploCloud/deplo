-- What a migration is still writing to, and must not be touched while it does.
--
-- An import creates apps, databases, projects and environments over minutes: it
-- writes the config, then copies gigabytes of data into their volumes, and the
-- whole run can still be reverted wholesale. Acting on one of those rows in the
-- middle - deploying it, renaming it, deleting it - races the import for the
-- same row, and the loser is whoever pressed the button.
--
-- So the run that is creating a row stamps its id here, every mutation refuses
-- while it is set, and the UI draws the row pulsing. NULL is every row that is
-- not being migrated right now, which is all of them the moment a run ends: the
-- mark is cleared by finish, by stop, and by the next run marking an abandoned
-- one interrupted. Never set on something an import merely REUSED - a project
-- that was already here keeps working while a migration writes inside it.
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "migration_run_id" text;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "migration_run_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "migration_run_id" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "migration_run_id" text;
