-- Per-app / per-database metrics-history opt-in — the "Save metrics" switch on
-- each app's and each database's Monitoring tab. One boolean column per table,
-- DEFAULT false (OFF), so nothing changes for existing rows: the fleet-wide
-- monitoring_settings singleton defaults ON because keeping host history is cheap
-- and expected, but keeping a rolling in-RAM window + a background sampler running
-- for EVERY app/database would be steady work nobody asked for — so this is a
-- per-resource debugging switch the operator flips deliberately.
--
-- The samples themselves never land in Postgres (a per-second time series is
-- ring-buffer data, kept in lib/monitoring/container-history.ts); this migration
-- only records WHICH apps/databases the control plane should keep history for.
-- Purely additive; no backfill.
--
-- Hand-authored: this repo's committed drizzle snapshots stop at 0014, so
-- `drizzle-kit generate` cannot diff against an up-to-date base. The SQL + journal
-- entry below are what the boot migrator (lib/db/migrate.ts) and the pglite tests
-- actually replay, matching every migration since 0015.
ALTER TABLE "apps" ADD COLUMN "save_metrics" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "save_metrics" boolean DEFAULT false NOT NULL;
