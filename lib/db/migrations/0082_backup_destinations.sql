-- A backup destination is a bucket OR a server's disk.
--
-- Until now the only place a backup could go was S3, which meant signing up for
-- a bucket before you could take a first backup - infrastructure you may not
-- have, demanded as a precondition for the most basic safety feature, on a
-- platform whose whole point is using what you already pay for. The artifact was
-- never bucket-shaped though: it is one opaque compressed stream, and a file on
-- a VPS is as valid a place to put it.
--
-- So `s3_destination` becomes `backup_destination` with a `kind`. RENAME rather
-- than a new table: Postgres carries the foreign keys, the indexes and the rows
-- across a rename, so `backups.destination_id` and `backup_runs.destination_id`
-- keep pointing at the same rows and no data moves. Leaving the table named
-- s3_destination while it holds server rows is the kind of lie someone pays for
-- at 3am.
ALTER TABLE "s3_destination" RENAME TO "backup_destination";
--> statement-breakpoint
ALTER INDEX "s3_destination_team_created_idx" RENAME TO "backup_destination_team_created_idx";
--> statement-breakpoint
ALTER INDEX "s3_destination_last_test_server_idx" RENAME TO "backup_destination_last_test_server_idx";
--> statement-breakpoint

-- Every existing row is an S3 bucket. The DEFAULT makes that true without a
-- backfill pass, and is then dropped so a new row must say what it is.
ALTER TABLE "backup_destination" ADD COLUMN "kind" text DEFAULT 's3' NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_destination" ALTER COLUMN "kind" DROP DEFAULT;
--> statement-breakpoint

-- Which server holds the artifacts, for kind='server'.
--
-- RESTRICT, matching backups.destination_id: removing a server that still holds
-- a team's only backups must be a decision someone makes, not a cascade that
-- quietly empties the destination list. The removal dialog reads this and says so.
ALTER TABLE "backup_destination" ADD COLUMN "server_id" text;
--> statement-breakpoint
ALTER TABLE "backup_destination" ADD CONSTRAINT "backup_destination_server_id_servers_id_fk"
  FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "backup_destination_server_idx" ON "backup_destination" ("server_id");
--> statement-breakpoint

-- The directory on that server. NULL means the agent's own managed store
-- (<data-base>/backups), which is the only shape a non-admin can produce and the
-- only one the agent creates on demand. A non-NULL path is the advanced case and
-- is accepted by the agent only once it carries the sentinel file the agent
-- itself wrote onto an empty directory.
ALTER TABLE "backup_destination" ADD COLUMN "path" text;
--> statement-breakpoint

-- Store artifacts are ALWAYS encrypted, with one age X25519 keypair per
-- destination.
--
-- The split is the point. `age_recipient` is the PUBLIC half and travels to the
-- agent on every backup, so a server can write artifacts it cannot itself read
-- and a compromised storage box yields ciphertext. `age_identity_enc` is the
-- private half, encrypted at rest with DEPLO_SECRET like every other secret here,
-- and it only ever leaves the control plane on a restore or a download.
--
-- `recovery_key_saved_at` drives the nudge on the destination card. An encrypted
-- backup whose key exists only inside the thing that might be lost is not a
-- backup, so the key is downloadable until the operator confirms they have it.
ALTER TABLE "backup_destination" ADD COLUMN "age_recipient" text;
--> statement-breakpoint
ALTER TABLE "backup_destination" ADD COLUMN "age_identity_enc" text;
--> statement-breakpoint
ALTER TABLE "backup_destination" ADD COLUMN "recovery_key_saved_at" timestamp with time zone;
--> statement-breakpoint

-- What the last check saw on a server destination: the filesystem's headroom and
-- the root the agent actually resolved (the managed one when `path` is NULL).
-- Stored so the card can show both without a second RPC per render. The free
-- space is information for the operator, never a pre-flight gate - a dump's size
-- is not knowable before it exists, so ENOSPC on the write is the real guard.
ALTER TABLE "backup_destination" ADD COLUMN "last_free_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "backup_destination" ADD COLUMN "last_total_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "backup_destination" ADD COLUMN "resolved_path" text;
--> statement-breakpoint

-- The six S3 columns are no longer universal: a server destination has no
-- bucket, no endpoint and no credentials.
ALTER TABLE "backup_destination" ALTER COLUMN "provider" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_destination" ALTER COLUMN "endpoint" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_destination" ALTER COLUMN "region" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_destination" ALTER COLUMN "bucket" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_destination" ALTER COLUMN "access_key_enc" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_destination" ALTER COLUMN "secret_key_enc" DROP NOT NULL;
--> statement-breakpoint

-- Dropping six NOT NULLs would leave nothing stopping a half-filled row, so the
-- shape moves into a CHECK: each kind names exactly what it must have and what
-- it must not. A server row carrying S3 credentials, or an S3 row pointing at a
-- server, is a bug in the writer and fails here rather than at backup time.
ALTER TABLE "backup_destination" ADD CONSTRAINT "backup_destination_kind_shape" CHECK (
  (kind = 's3' AND provider IS NOT NULL AND endpoint IS NOT NULL AND region IS NOT NULL
     AND bucket IS NOT NULL AND access_key_enc IS NOT NULL AND secret_key_enc IS NOT NULL
     AND server_id IS NULL AND age_recipient IS NULL AND age_identity_enc IS NULL)
  OR
  (kind = 'server' AND server_id IS NOT NULL AND age_recipient IS NOT NULL
     AND age_identity_enc IS NOT NULL AND bucket IS NULL AND access_key_enc IS NULL
     AND secret_key_enc IS NULL)
);
--> statement-breakpoint

-- A VPS bought purely to hold backups: the agent is installed, Docker is not.
--
-- Without this the host sits permanently red - the readiness check for
-- docker.available is severity `fail`, and server health returns `warning`
-- forever, so the product would ship a screen that accuses the user's storage
-- box of being broken for doing exactly what it was bought to do.
ALTER TABLE "servers" ADD COLUMN "storage_only" boolean DEFAULT false NOT NULL;
