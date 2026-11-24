ALTER TABLE "backup_runs" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "cluster_app_replicas" ADD COLUMN "relayed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "disk_full_at" timestamp with time zone;