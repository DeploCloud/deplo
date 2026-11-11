-- The last measured restore speed of a database, for the recovery estimate on a cluster (spec #176).
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "restore_bytes_per_sec" bigint;
