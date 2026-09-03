-- The database hostnames a migration run renamed, kept for every project of that
-- run: an app imported later that names a database imported earlier is rewritten too.
CREATE TABLE "migration_run_db_hosts" (
  "run_id" text NOT NULL REFERENCES "migration_runs"("id") ON DELETE CASCADE,
  "source_host" text NOT NULL,
  "target_host" text NOT NULL,
  "environment_id" text,
  PRIMARY KEY ("run_id", "source_host")
);
