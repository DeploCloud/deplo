-- Clusters (spec #176): several servers that act as one; a cluster is shared across teams like a server.
CREATE TABLE "clusters" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"all_teams" boolean DEFAULT true NOT NULL,
	"leader_server_id" text,
	"leader_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster_teams" (
	"cluster_id" text NOT NULL,
	"team_id" text NOT NULL,
	CONSTRAINT "cluster_teams_cluster_id_team_id_pk" PRIMARY KEY("cluster_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "cluster_leader_keys" (
	"cluster_id" text NOT NULL,
	"public_key" text NOT NULL,
	"server_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cluster_leader_keys_cluster_id_public_key_pk" PRIMARY KEY("cluster_id","public_key")
);
--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_leader_server_id_servers_id_fk" FOREIGN KEY ("leader_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_teams" ADD CONSTRAINT "cluster_teams_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_teams" ADD CONSTRAINT "cluster_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_leader_keys" ADD CONSTRAINT "cluster_leader_keys_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_leader_keys" ADD CONSTRAINT "cluster_leader_keys_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cluster_teams_team_idx" ON "cluster_teams" USING btree ("team_id");
