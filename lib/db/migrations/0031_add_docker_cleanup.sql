-- Docker cleanup — reclaim build cache and unused images on the fleet, on a schedule.
--
-- The schedule is a SINGLETON policy (`docker_cleanup_policy`, PK fixed at 'default'),
-- not a row per server: "daily at 04:00, keep 3 images, drop caches older than a week"
-- is a property of the fleet, and a host that must be left alone opts OUT via
-- `docker_cleanup_excluded_servers`. One schedule to reason about, and a server added
-- tomorrow cannot silently go un-swept. The manual "clean up now" ignores the exclusion
-- list — an operator pressing the button has already made that decision.
--
-- The selected scopes are a LIST, so `docker_cleanup_policy_scopes` is a junction, never
-- a JSONB array. `scope` is one of four wire ids — build_cache, dangling_images,
-- orphan_buildkit_cache, unused_app_images — and that set is an ALLOW-LIST: the agent
-- only ever removes objects it can PROVE are unreferenced. There is no container /
-- volume / network / `system` prune scope and there must never be one. On a Deplo host a
-- STOPPED app is a LIVE app (StopStack is `docker compose stop`, so the container must
-- survive or the app becomes unstartable), and a dangling anonymous volume may hold user
-- data (a live MongoDB's WiredTiger files were found in one on the production host).
--
-- `scope`, `status` and `trigger` stay plain `text` with no CHECK, like
-- `backup_runs.status`: the boundary that protects the host is the agent's own
-- allow-list, plus the data layer's validation on write. A CHECK here would only add a
-- second place for the set to drift from the proto enum, while protecting nothing.
--
-- `docker_cleanup_runs` is the history — one row per server per execution, written as
-- `running` BEFORE the agent is dialled, so an unreachable agent still lands as a failed
-- run. History never lies about a sweep that was attempted. `server_id` is SET NULL and
-- `server_name` is denormalized beside it: the history outlives the server, so "we
-- reclaimed 9 GB on eu-main-1 last Tuesday" still reads as that sentence once the host is
-- gone. `seq bigint identity` breaks same-millisecond ties, so `ORDER BY started_at DESC,
-- seq DESC` is a total order. Byte counts are `bigint` (the `backup_runs.size_bytes`
-- rule) — a full build cache passes 2 GB routinely and would overflow `integer`.
--
-- The partial index on `status = 'running'` serves the boot reconcile (settle rows
-- stranded by a control-plane restart) and the scheduler's never-stack-runs check.
--
-- All five tables are NEW, so there is nothing to backfill and no NOT NULL to add to a
-- populated table — the migrator auto-applies at boot against live self-hosted DBs. A
-- MISSING policy row is legal and means "never configured"; the data layer answers with
-- disabled defaults, the way a missing `notification_settings` row does.
CREATE TABLE "docker_cleanup_excluded_servers" (
	"server_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docker_cleanup_policy" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"enabled" boolean NOT NULL,
	"schedule" text NOT NULL,
	"min_age_hours" integer NOT NULL,
	"keep_images_per_app" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docker_cleanup_policy_scopes" (
	"policy_id" text NOT NULL,
	"scope" text NOT NULL,
	CONSTRAINT "docker_cleanup_policy_scopes_policy_id_scope_pk" PRIMARY KEY("policy_id","scope")
);
--> statement-breakpoint
CREATE TABLE "docker_cleanup_run_items" (
	"run_id" text NOT NULL,
	"scope" text NOT NULL,
	"reclaimed_bytes" bigint NOT NULL,
	"items_removed" integer NOT NULL,
	"skipped" boolean NOT NULL,
	"error" text,
	CONSTRAINT "docker_cleanup_run_items_run_id_scope_pk" PRIMARY KEY("run_id","scope")
);
--> statement-breakpoint
CREATE TABLE "docker_cleanup_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "docker_cleanup_runs_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"server_id" text,
	"server_name" text NOT NULL,
	"trigger" text NOT NULL,
	"actor" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"reclaimed_bytes" bigint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "docker_cleanup_excluded_servers" ADD CONSTRAINT "docker_cleanup_excluded_servers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_cleanup_policy_scopes" ADD CONSTRAINT "docker_cleanup_policy_scopes_policy_id_docker_cleanup_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."docker_cleanup_policy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_cleanup_run_items" ADD CONSTRAINT "docker_cleanup_run_items_run_id_docker_cleanup_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."docker_cleanup_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_cleanup_runs" ADD CONSTRAINT "docker_cleanup_runs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docker_cleanup_runs_server_started_idx" ON "docker_cleanup_runs" USING btree ("server_id","started_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "docker_cleanup_runs_running_idx" ON "docker_cleanup_runs" USING btree ("status") WHERE "docker_cleanup_runs"."status" = 'running';
