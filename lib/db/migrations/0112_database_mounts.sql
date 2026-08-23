-- A database's own config files.
--
-- An engine is configured by a FILE at least as often as by a flag: postgresql.conf,
-- my.cnf, redis.conf, a script under /docker-entrypoint-initdb.d. Deplo could
-- render an image override and a command override but not that, so the answer to
-- "how do I raise shared_buffers" was a shell on the host - the one thing deplo
-- exists to never require - and a migration off another platform silently dropped
-- every file mount a database had.
--
-- Same shape as `app_mounts`, plus the one thing an App does not need here:
-- `mount_path`. An App's config files are bound by something that already knows
-- where they go (the stack's own compose, or a Storage File entry); a database's
-- compose is rendered by deplo, so the row itself has to say where in the
-- container the file lands.
--
-- Ordered child, `(database_id, position)` PK, ON DELETE CASCADE - a deleted
-- database takes its files with it, on disk (the agent sweeps files/<slug>) and
-- here.
CREATE TABLE IF NOT EXISTS "database_mounts" (
  "database_id" text NOT NULL REFERENCES "databases"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "file_path" text NOT NULL,
  "content" text NOT NULL,
  "mount_path" text NOT NULL,
  CONSTRAINT "database_mounts_pk" PRIMARY KEY ("database_id", "position")
);
