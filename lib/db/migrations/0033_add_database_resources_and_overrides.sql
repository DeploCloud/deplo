-- Databases become manageable like Apps (the /storage/databases/[id] detail
-- page): per-database resource limits plus expert image/command overrides, set
-- from the database's Settings pages (no Docker/compose knowledge required).
--
-- The twelve resource_* columns are the EXACT flattened ResourceLimits block
-- `apps` carries (migration 0032) — same names, same units (memory in
-- MEBIBYTES, disk in GIBIBYTES, CPU in MILLI-CPUs), same NULL ⇒ uncapped /
-- all-NULL ⇒ `resources: null` contract — so both tables share the single
-- column↔field mapping in lib/data/app-graph-rows.ts and the compose renderer
-- in lib/deploy/resources.ts. A database that never opened the Resources page
-- renders a byte-identical stack.
--
-- `custom_image` replaces the derived engine image (DB_IMAGES[type](version);
-- version is inert while set); `custom_command` replaces the container command
-- verbatim (redis's default carries `--requirepass`, the UI warns). Both apply
-- at the next provision/reroute.
--
-- Purely additive, no defaults and no NOT NULL, so existing rows need no
-- backfill and the migrator can auto-apply this at boot against live DBs.
ALTER TABLE "databases" ADD COLUMN "resource_mem_limit_mb" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_mem_reservation_mb" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_mem_swap_mb" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_cpu_milli" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_cpu_shares" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_cpuset" text;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_pids_limit" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_shm_size_mb" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_storage_size_gb" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_ulimit_nofile" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_ulimit_nproc" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "resource_oom_score_adj" integer;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "custom_image" text;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "custom_command" text;
