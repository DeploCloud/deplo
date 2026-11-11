-- An Activity entry that says a workload changed servers: what the charts mark, read as a fact and not from its wording (spec #176).
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "server_change" boolean DEFAULT false NOT NULL;
