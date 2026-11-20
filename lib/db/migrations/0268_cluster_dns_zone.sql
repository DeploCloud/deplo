CREATE TABLE "cluster_dns_zones" (
	"id" text PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster_name_servers" (
	"cluster_id" text NOT NULL,
	"position" integer NOT NULL,
	"server_id" text NOT NULL,
	CONSTRAINT "cluster_name_servers_cluster_id_position_pk" PRIMARY KEY("cluster_id","position")
);
--> statement-breakpoint
CREATE TABLE "cluster_zone_states" (
	"cluster_id" text NOT NULL,
	"server_id" text NOT NULL,
	"serving" boolean DEFAULT false NOT NULL,
	"problem" text DEFAULT '' NOT NULL,
	"state" text NOT NULL,
	"heard" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cluster_zone_states_cluster_id_server_id_pk" PRIMARY KEY("cluster_id","server_id")
);
--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "dns_answer_ttl" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "dns_drop_after" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dns_zone_id" text;--> statement-breakpoint
ALTER TABLE "cluster_dns_zones" ADD CONSTRAINT "cluster_dns_zones_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_name_servers" ADD CONSTRAINT "cluster_name_servers_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_name_servers" ADD CONSTRAINT "cluster_name_servers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_zone_states" ADD CONSTRAINT "cluster_zone_states_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_dns_zones_name_uq" ON "cluster_dns_zones" USING btree ("name");--> statement-breakpoint
CREATE INDEX "cluster_dns_zones_cluster_idx" ON "cluster_dns_zones" USING btree ("cluster_id");--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_dns_zone_id_cluster_dns_zones_id_fk" FOREIGN KEY ("dns_zone_id") REFERENCES "public"."cluster_dns_zones"("id") ON DELETE set null ON UPDATE no action;