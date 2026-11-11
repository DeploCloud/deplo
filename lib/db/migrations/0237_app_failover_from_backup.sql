ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "failover_from_backup" boolean DEFAULT false NOT NULL;
