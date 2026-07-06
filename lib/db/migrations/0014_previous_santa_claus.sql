-- Add nullable first so existing rows survive (a bare ADD COLUMN ... NOT NULL
-- with no default fails on a non-empty table). Backfill, then enforce NOT NULL —
-- the standard drizzle pattern; the meta snapshot already reflects the final
-- NOT NULL columns.
ALTER TABLE "databases" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "db_name" text;--> statement-breakpoint

-- Backfill `username` to the historical per-engine CONNECTION-STRING identity
-- (createDatabase set 'default' for redis and 'app' for every other engine —
-- including mysql/mariadb, whose *connection string* user was 'app'). The dump
-- path maps mysql/mariadb to 'root' at read time (dumpUserFor), so we must NOT
-- backfill 'root' here or every legacy connection string would silently change
-- identity.
UPDATE "databases"
SET "username" = CASE WHEN "type" = 'redis' THEN 'default' ELSE 'app' END
WHERE "username" IS NULL;--> statement-breakpoint

-- Backfill `db_name` to `host` (== the service name `db-<name>`), which is the
-- logical database existing rows actually created (the compose emitted
-- POSTGRES_DB=db-<name> / MYSQL_DATABASE=db-<name>, and the backup descriptor
-- dumped db.host). Backfilling to the bare `name` would point backups at a
-- database that never existed.
UPDATE "databases" SET "db_name" = "host" WHERE "db_name" IS NULL;--> statement-breakpoint

ALTER TABLE "databases" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ALTER COLUMN "db_name" SET NOT NULL;
