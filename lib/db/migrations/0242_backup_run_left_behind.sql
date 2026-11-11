-- Data a returning cluster member had left is kept as a backup run: the server it was on, and when the failover happened (spec #176, #206).
ALTER TABLE "backup_runs" ADD COLUMN IF NOT EXISTS "left_on_server_id" text;
--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN IF NOT EXISTS "left_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_left_on_server_id_servers_id_fk" FOREIGN KEY ("left_on_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
