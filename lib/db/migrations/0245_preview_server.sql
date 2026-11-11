-- The server a pull request preview's stack runs on: a cluster places each one on a member of its own (spec #176, #212).
ALTER TABLE "app_previews" ADD COLUMN IF NOT EXISTS "server_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_previews" ADD CONSTRAINT "app_previews_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_previews_server_idx" ON "app_previews" USING btree ("server_id");
