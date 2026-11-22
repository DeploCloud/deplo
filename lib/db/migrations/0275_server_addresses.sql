CREATE TABLE "server_addresses" (
	"server_id" text NOT NULL,
	"address" text NOT NULL,
	"origin" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone,
	"proven_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"problem" text DEFAULT '' NOT NULL,
	CONSTRAINT "server_addresses_server_id_address_pk" PRIMARY KEY("server_id","address")
);
--> statement-breakpoint
ALTER TABLE "server_addresses" ADD CONSTRAINT "server_addresses_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;