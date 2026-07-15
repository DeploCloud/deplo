-- Per-app resource limits — cap an app's RAM / CPU / PIDs / disk / IO so one
-- app can't starve its neighbours on a shared host, set from the app's
-- Settings → Resources page (no Docker/compose knowledge required).
--
-- Twelve NULLABLE columns flattened onto `apps`, exactly like the existing
-- `repo_*` / `upload_*` groups: NULL ⇒ that dimension is UNCAPPED, and an
-- all-NULL row assembles back to `App.resources = null` (no limits set). This is
-- the byte-identical-stack contract the volumes/env work relies on — an app that
-- never opened the Resources page renders precisely the compose it always did,
-- so a reroute of an unchanged routing set never restarts the container.
--
-- Purely additive, no default and no NOT NULL, so existing rows need no backfill
-- and the migrator can auto-apply this at boot against live self-hosted DBs.
--
-- Units are chosen so every value is a clean INTEGER (no float column, per the
-- no-JSONB / normalized-store rules): memory sizes in MEBIBYTES, disk in
-- GIBIBYTES, CPU in MILLI-CPUs (1000 = one core). `resource_cpuset` is the one
-- text field (a CPU list like "0,2-3"). The values are emitted at deploy time as
-- `docker compose up` container keys (mem_limit / cpus / pids_limit / shm_size /
-- ulimits / storage_opt) — see lib/deploy/resources.ts.
ALTER TABLE "apps" ADD COLUMN "resource_mem_limit_mb" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_mem_reservation_mb" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_mem_swap_mb" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_cpu_milli" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_cpu_shares" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_cpuset" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_pids_limit" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_shm_size_mb" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_storage_size_gb" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_ulimit_nofile" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_ulimit_nproc" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "resource_oom_score_adj" integer;
