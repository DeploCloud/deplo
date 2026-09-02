-- The wizard asked "same machine?" to allow a private panel address. The address
-- already says it: private now means instance admin, derived at the dial.
ALTER TABLE "migration_runs" DROP COLUMN IF EXISTS "allow_private";
