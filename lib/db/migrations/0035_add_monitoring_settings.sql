-- Monitoring settings — a SINGLETON row (PK fixed at 'default'), the shape of
-- docker_cleanup_policy, and instance-wide for the same reason: servers are the one
-- shared cross-team resource, so whether the control plane keeps their metrics
-- history is a property of the fleet, not of a team.
--
-- The one knob is `save_metrics`: when true the control plane keeps a short rolling
-- metrics history per server IN PROCESS MEMORY (lib/monitoring/history.ts), fed by a
-- background collector plus every live dashboard poll, so the Monitoring charts
-- survive a page reload instead of starting empty. The samples themselves never
-- land in Postgres — a per-second time series is ring-buffer data, not relational
-- state — which is why this migration adds a settings row and no samples table.
--
-- A missing row is legal and means "never configured"; the data layer answers with
-- the default (enabled). Purely additive; no backfill.
CREATE TABLE "monitoring_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"save_metrics" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
