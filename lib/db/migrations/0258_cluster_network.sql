-- The servers of a cluster share a private network (ADR-0047): each one's tunnel key, and how each pair reaches the other.
CREATE TABLE "cluster_network_links" (
	"cluster_id" text NOT NULL,
	"server_id" text NOT NULL,
	"peer_server_id" text NOT NULL,
	"path" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cluster_network_links_cluster_id_server_id_peer_server_id_pk" PRIMARY KEY("cluster_id","server_id","peer_server_id")
);
--> statement-breakpoint
CREATE TABLE "cluster_network_peers" (
	"cluster_id" text NOT NULL,
	"server_id" text NOT NULL,
	"public_key" text NOT NULL,
	"port" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cluster_network_peers_cluster_id_server_id_pk" PRIMARY KEY("cluster_id","server_id")
);
--> statement-breakpoint
ALTER TABLE "cluster_network_links" ADD CONSTRAINT "cluster_network_links_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_network_links" ADD CONSTRAINT "cluster_network_links_peer_server_id_servers_id_fk" FOREIGN KEY ("peer_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_network_peers" ADD CONSTRAINT "cluster_network_peers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cluster_network_peers_server_idx" ON "cluster_network_peers" USING btree ("server_id");