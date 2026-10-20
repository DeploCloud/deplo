CREATE TABLE "server_agent_updates" (
	"server_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"failure" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"target_version" text NOT NULL,
	"first_failed_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"revived" boolean DEFAULT false NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_agent_updates" ADD CONSTRAINT "server_agent_updates_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;