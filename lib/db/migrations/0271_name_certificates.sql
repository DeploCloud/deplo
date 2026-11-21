CREATE TABLE "cluster_name_certs" (
	"zone_id" text NOT NULL,
	"name" text NOT NULL,
	"renewer_server_id" text,
	"renewer_lost_at" timestamp with time zone,
	"cert_pem" text,
	"key_enc" text,
	"sha256" text,
	"not_after" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"renewed_at" timestamp with time zone,
	"error" text DEFAULT '' NOT NULL,
	"error_at" timestamp with time zone,
	"ordering" boolean DEFAULT false NOT NULL,
	CONSTRAINT "cluster_name_certs_zone_id_name_pk" PRIMARY KEY("zone_id","name")
);
--> statement-breakpoint
ALTER TABLE "cluster_name_certs" ADD CONSTRAINT "cluster_name_certs_zone_id_cluster_dns_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."cluster_dns_zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_name_certs" ADD CONSTRAINT "cluster_name_certs_renewer_server_id_servers_id_fk" FOREIGN KEY ("renewer_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;