-- Replication streams a cluster's stored data to its other servers; it replaces failing over from a backup.
CREATE TABLE "cluster_app_replicas" (
	"app_id" text NOT NULL,
	"server_id" text NOT NULL,
	"role" text NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"synced" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cluster_app_replicas_app_id_server_id_pk" PRIMARY KEY("app_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "cluster_entrances" (
	"app_id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"chosen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "replication_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "load_balancing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "load_balancing_mode" text DEFAULT 'nearest' NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "standby_from_cluster" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster_app_replicas" ADD CONSTRAINT "cluster_app_replicas_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_app_replicas" ADD CONSTRAINT "cluster_app_replicas_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_entrances" ADD CONSTRAINT "cluster_entrances_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_entrances" ADD CONSTRAINT "cluster_entrances_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cluster_app_replicas_server_idx" ON "cluster_app_replicas" USING btree ("server_id");
