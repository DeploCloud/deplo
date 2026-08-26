-- The migration feature reads two platforms now, so its tables stop naming one.
-- A pure rename: no data moves, and the constraint names keep the old spelling
-- because nothing reads them.
ALTER TABLE "dokploy_imports" RENAME TO "migration_runs";--> statement-breakpoint
ALTER TABLE "dokploy_import_items" RENAME TO "migration_run_items";--> statement-breakpoint
ALTER TABLE "dokploy_run_targets" RENAME TO "migration_run_targets";--> statement-breakpoint
ALTER TABLE "dokploy_run_servers" RENAME TO "migration_run_servers";--> statement-breakpoint
ALTER TABLE "dokploy_source_addresses" RENAME TO "migration_source_addresses";--> statement-breakpoint
ALTER INDEX "dokploy_imports_team_started_idx" RENAME TO "migration_runs_team_started_idx";--> statement-breakpoint
ALTER INDEX "dokploy_import_items_run_idx" RENAME TO "migration_run_items_run_idx";--> statement-breakpoint
ALTER INDEX "dokploy_run_targets_run_idx" RENAME TO "migration_run_targets_run_idx";--> statement-breakpoint
-- Which product a run read. Decided once at Connect and never re-derived: the
-- runner resumes hours later from this row, and a detection that answered
-- differently the second time would point the data cutover - the destructive
-- half - at the wrong API. Every row that predates two platforms is a Dokploy.
ALTER TABLE "migration_runs"
  ADD COLUMN IF NOT EXISTS "platform" text DEFAULT 'dokploy' NOT NULL;
