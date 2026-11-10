-- Cluster members (spec #176): a server is in at most one cluster; its workloads carry the cluster id.
CREATE TABLE IF NOT EXISTS "cluster_members" (
	"server_id" text PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"emptying_since" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "cluster_id" text;
--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "cluster_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cluster_members" ADD CONSTRAINT "cluster_members_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cluster_members" ADD CONSTRAINT "cluster_members_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "apps" ADD CONSTRAINT "apps_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "databases" ADD CONSTRAINT "databases_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cluster_members_cluster_idx" ON "cluster_members" USING btree ("cluster_id");
