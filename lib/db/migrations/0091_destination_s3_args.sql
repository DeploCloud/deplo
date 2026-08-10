-- A destination's advanced S3 flags, as the operator typed them.
--
-- Every S3-compatible store is compatible in its own way, and the ones that need
-- a workaround need a different one each: a gateway that rejects a signature
-- covering Accept-Encoding, a MinIO on a self-signed certificate, a store that
-- only answers path-style. One text column rather than a boolean per quirk, so
-- the next one is not a migration - the allowlist that decides which flags mean
-- anything lives in lib/backups/s3-args.ts and in the agent, not in the schema.
--
-- NULL means none, which is every destination that exists today and almost every
-- one that ever will.

ALTER TABLE "backup_destination" ADD COLUMN IF NOT EXISTS "s3_extra_args" text;
