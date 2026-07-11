-- Per-server deployment queue (Coolify `concurrent_builds` analogue).
--
--   servers.deploy_concurrency   how many deploys this server runs at once. Default
--                                1 = strict per-server serialization; deploys on
--                                other servers still run in parallel. Additive:
--                                existing rows get 1 (no behaviour change).
--   deployments.server_id        denormalized owning server (mirrors
--                                services.server_id at insert) so the queue can
--                                drain per-server without a services join. Nullable
--                                + backfilled for pre-existing rows; every new
--                                deploy sets it. NOT a FK — a deployment is a
--                                historical record that outlives its server.
--   deployments_queued_server_idx  the drain's hot path: oldest queued deploy per
--                                server. PARTIAL (queued-only) so it indexes just
--                                the live backlog, ascending (created_at, seq) to
--                                match the FIFO drain order.
ALTER TABLE "servers" ADD COLUMN "deploy_concurrency" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "server_id" text;--> statement-breakpoint
UPDATE "deployments" AS d SET "server_id" = s."server_id" FROM "services" AS s WHERE d."service_id" = s."id" AND d."server_id" IS NULL;--> statement-breakpoint
CREATE INDEX "deployments_queued_server_idx" ON "deployments" ("server_id","created_at","seq") WHERE "status" = 'queued';
