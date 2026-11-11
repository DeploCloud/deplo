-- A cluster database's standby copy: the switch, and the mark of the copy's current seed (spec #176, #218).
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "standby" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "standby_seed" text;
