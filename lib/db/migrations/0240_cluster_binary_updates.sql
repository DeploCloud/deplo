-- A cluster binary update that is failing on a server, kept so the retry and its wait survive a restart (spec #176).
CREATE TABLE IF NOT EXISTS "cluster_binary_updates" (
	"server_id" text PRIMARY KEY NOT NULL,
	"target_version" text NOT NULL,
	"failure" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"first_failed_at" timestamp with time zone NOT NULL,
	"next_retry_at" timestamp with time zone NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cluster_binary_updates" ADD CONSTRAINT "cluster_binary_updates_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
