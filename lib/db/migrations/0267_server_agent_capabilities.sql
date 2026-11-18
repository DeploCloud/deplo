CREATE TABLE "server_agent_capabilities" (
	"server_id" text NOT NULL,
	"capability" text NOT NULL,
	"agent_version" text NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "server_agent_capabilities_server_id_capability_pk" PRIMARY KEY("server_id","capability")
);
--> statement-breakpoint
ALTER TABLE "server_agent_capabilities" ADD CONSTRAINT "server_agent_capabilities_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;