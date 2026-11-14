-- A cluster can stop failing over: its leader then holds no failover bundle and moves nothing.
ALTER TABLE "clusters" ADD COLUMN IF NOT EXISTS "failover_enabled" boolean DEFAULT true NOT NULL;
