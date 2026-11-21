CREATE TABLE "server_retired_certs" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"cert_pem" text NOT NULL,
	"retired_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "agent_next_cert_fingerprint" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "agent_next_cert_pem" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "deplo_host" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "connected_from" text;--> statement-breakpoint
ALTER TABLE "server_retired_certs" ADD CONSTRAINT "server_retired_certs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_retired_certs_server_idx" ON "server_retired_certs" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_next_cert_fingerprint_uq" ON "servers" USING btree ("agent_next_cert_fingerprint") WHERE "servers"."agent_next_cert_fingerprint" is not null;