ALTER TABLE "instance_settings" ADD COLUMN "experiment_crons" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "experiment_zero_downtime" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "experiment_pull_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "experiment_clusters" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "experiment_tunnels" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- An update keeps on every experiment the instance already uses; a fresh install gets no row here.
INSERT INTO "instance_settings" ("id", "updated_at", "experiment_crons", "experiment_zero_downtime", "experiment_pull_requests", "experiment_clusters", "experiment_tunnels")
SELECT 'default', now(), u.crons, u.zero_downtime, u.pull_requests, u.clusters, u.tunnels
FROM (
  SELECT
    EXISTS (SELECT 1 FROM "apps" WHERE "cron_enabled" AND "deleting_at" IS NULL)
      OR EXISTS (SELECT 1 FROM "databases" WHERE "cron_enabled") AS crons,
    EXISTS (SELECT 1 FROM "apps" WHERE "zero_downtime_deploys" AND "deleting_at" IS NULL) AS zero_downtime,
    EXISTS (SELECT 1 FROM "apps" WHERE "preview_enabled" AND "deleting_at" IS NULL)
      OR EXISTS (SELECT 1 FROM "app_previews" WHERE "torn_down_at" IS NULL) AS pull_requests,
    EXISTS (SELECT 1 FROM "clusters") AS clusters,
    EXISTS (SELECT 1 FROM "domains" WHERE "tunnel")
      OR EXISTS (SELECT 1 FROM "instance_settings" WHERE "id" = 'default' AND "panel_tunnel_hostname" IS NOT NULL) AS tunnels
) u
WHERE u.crons OR u.zero_downtime OR u.pull_requests OR u.clusters OR u.tunnels
ON CONFLICT ("id") DO UPDATE SET
  "experiment_crons" = EXCLUDED."experiment_crons",
  "experiment_zero_downtime" = EXCLUDED."experiment_zero_downtime",
  "experiment_pull_requests" = EXCLUDED."experiment_pull_requests",
  "experiment_clusters" = EXCLUDED."experiment_clusters",
  "experiment_tunnels" = EXCLUDED."experiment_tunnels";
