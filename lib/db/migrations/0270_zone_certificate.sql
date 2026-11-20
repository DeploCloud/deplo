CREATE TABLE "cluster_zone_certs" (
	"zone_id" text PRIMARY KEY NOT NULL,
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
	"ordering" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "dns_wildcard" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "acme_cname_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "cert_challenge" text;--> statement-breakpoint
ALTER TABLE "cluster_zone_certs" ADD CONSTRAINT "cluster_zone_certs_zone_id_cluster_dns_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."cluster_dns_zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_zone_certs" ADD CONSTRAINT "cluster_zone_certs_renewer_server_id_servers_id_fk" FOREIGN KEY ("renewer_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;