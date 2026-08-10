-- What a backup run is worth is what you can prove about it, and what it costs
-- is the disk it never gives back. This migration adds the columns for both,
-- plus the two knobs the audit turned up.
--
-- backup_runs.sha256      the artifact's identity, checked before a restore ever
--                         feeds its bytes to `docker compose up`
-- backup_runs.target_id   the target's id as plain text, so it survives the
--                         ON DELETE SET NULL that used to orphan artifacts
-- backups.timezone        the zone a cron is read in (was UTC, unwritten)
-- backup_destination.allow_private_endpoint
--                         a self-hosted bucket on the operator's own network

ALTER TABLE "backup_runs" ADD COLUMN IF NOT EXISTS "sha256" text;
--> statement-breakpoint

ALTER TABLE "backup_runs" ADD COLUMN IF NOT EXISTS "target_id" text;
--> statement-breakpoint

-- Backfill from whichever FK still points somewhere. A row where BOTH are
-- already NULL is one whose target was deleted before this column existed: its
-- artifact is unreachable and unnameable, so the key it was written under is the
-- only identity left. `object_key` is deplo/<team>/<kind>/<targetId>/<file>, so
-- the fourth segment IS the target id.
UPDATE "backup_runs"
SET "target_id" = COALESCE(
  "database_id",
  "app_id",
  NULLIF(split_part("object_key", '/', 4), ''),
  'unknown'
)
WHERE "target_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "backup_runs" ALTER COLUMN "target_id" SET NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "backup_runs_team_target_idx"
  ON "backup_runs" ("team_id", "target_id");
--> statement-breakpoint

ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'UTC' NOT NULL;
--> statement-breakpoint

ALTER TABLE "backup_destination"
  ADD COLUMN IF NOT EXISTS "allow_private_endpoint" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- The age columns stop being the `server` kind's alone: a bucket artifact is
-- encrypted too now. They stay nullable for `s3` and only there, so every
-- destination created before this keeps resolving and keeps writing the
-- plaintext artifacts its existing objects already are.
ALTER TABLE "backup_destination" DROP CONSTRAINT IF EXISTS "backup_destination_kind_shape";
--> statement-breakpoint

ALTER TABLE "backup_destination" ADD CONSTRAINT "backup_destination_kind_shape" CHECK (
  ("kind" = 's3' and "provider" is not null and "endpoint" is not null
     and "region" is not null and "bucket" is not null
     and "access_key_enc" is not null and "secret_key_enc" is not null
     and "server_id" is null
     and (("age_recipient" is null and "age_identity_enc" is null)
       or ("age_recipient" is not null and "age_identity_enc" is not null)))
  or ("kind" = 'server' and "server_id" is not null and "age_recipient" is not null
     and "age_identity_enc" is not null and "bucket" is null
     and "access_key_enc" is null and "secret_key_enc" is null)
);
