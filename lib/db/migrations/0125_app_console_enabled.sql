-- The container console is now a feature an app turns ON, not one every app has.
-- Default false, and no backfill: an app that had it keeps it only once someone
-- with configure_apps says so.
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "console_enabled" boolean DEFAULT false NOT NULL;
