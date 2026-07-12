-- Rename the deployable-app entity Service -> App, and the installed App -> Plugin.
-- Hand-authored: drizzle-kit's non-interactive generate emits DROP+CREATE for a
-- rename (data loss). Mirrors 0015_rename_projects_to_services. Tables, service_id
-- columns, indexes, the backups XOR CHECK body, and the stored 'service'
-- discriminant values (backups/backup_runs target_kind, activities type,
-- app_volumes type) all migrate. IDs (prj_.../app_...) are opaque and stay on the
-- rows (no value rewrite). The agent wire (deplo.project=<id> label, deplo-<slug>
-- stack naming) is deliberately UNCHANGED — it carries the App id. The installed-
-- plugin container/label identity (deplo-app-<slug>, deplo.role=app, /data/apps,
-- app_ id prefix) is ALSO unchanged — only its Traefik path moved to /plugins/<slug>.
-- FK/PK constraint names are left as-is (functional; nothing reads them).

-- Tables: Service -> App --------------------------------------------------
ALTER TABLE "services" RENAME TO "apps";--> statement-breakpoint
ALTER TABLE "service_build" RENAME TO "app_build";--> statement-breakpoint
ALTER TABLE "service_build_method_settings" RENAME TO "app_build_method_settings";--> statement-breakpoint
ALTER TABLE "service_dev" RENAME TO "app_dev";--> statement-breakpoint
ALTER TABLE "service_volumes" RENAME TO "app_volumes";--> statement-breakpoint
ALTER TABLE "service_mounts" RENAME TO "app_mounts";--> statement-breakpoint
ALTER TABLE "service_basic_auth_users" RENAME TO "app_basic_auth_users";--> statement-breakpoint
ALTER TABLE "service_environments" RENAME TO "app_environments";--> statement-breakpoint
ALTER TABLE "team_service_order" RENAME TO "team_app_order";--> statement-breakpoint
ALTER TABLE "shared_env_group_services" RENAME TO "shared_env_group_apps";--> statement-breakpoint

-- Table: installed App -> Plugin -----------------------------------------
ALTER TABLE "installed_apps" RENAME TO "installed_plugins";--> statement-breakpoint

-- Columns service_id -> app_id (every table that has one; github_apps.app_id is
-- the GitHub App id and is never named service_id, so it is untouched). ------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'service_id' AND table_schema = current_schema()
  LOOP
    EXECUTE format('ALTER TABLE %I RENAME COLUMN service_id TO app_id', r.table_name);
  END LOOP;
END $$;--> statement-breakpoint

-- Indexes: Service -> App -------------------------------------------------
ALTER INDEX "services_slug_uq" RENAME TO "apps_slug_uq";--> statement-breakpoint
ALTER INDEX "services_team_idx" RENAME TO "apps_team_idx";--> statement-breakpoint
ALTER INDEX "services_folder_idx" RENAME TO "apps_folder_idx";--> statement-breakpoint
ALTER INDEX "services_project_idx" RENAME TO "apps_project_idx";--> statement-breakpoint
ALTER INDEX "services_environment_idx" RENAME TO "apps_environment_idx";--> statement-breakpoint
ALTER INDEX "env_vars_service_key_uq" RENAME TO "env_vars_app_key_uq";--> statement-breakpoint
ALTER INDEX "domains_service_idx" RENAME TO "domains_app_idx";--> statement-breakpoint
ALTER INDEX "deployments_service_created_idx" RENAME TO "deployments_app_created_idx";--> statement-breakpoint
ALTER INDEX "shared_env_group_services_service_idx" RENAME TO "shared_env_group_apps_app_idx";--> statement-breakpoint
ALTER INDEX "service_basic_auth_users_service_username_uq" RENAME TO "app_basic_auth_users_app_username_uq";--> statement-breakpoint
ALTER INDEX "service_basic_auth_users_service_idx" RENAME TO "app_basic_auth_users_app_idx";--> statement-breakpoint
ALTER INDEX "service_environments_environment_idx" RENAME TO "app_environments_environment_idx";--> statement-breakpoint

-- Indexes: installed_apps -> installed_plugins ---------------------------
ALTER INDEX "installed_apps_team_catalog_uq" RENAME TO "installed_plugins_team_catalog_uq";--> statement-breakpoint
ALTER INDEX "installed_apps_slug_uq" RENAME TO "installed_plugins_slug_uq";--> statement-breakpoint
ALTER INDEX "installed_apps_team_created_idx" RENAME TO "installed_plugins_team_created_idx";--> statement-breakpoint

-- backups target_kind 'service' -> 'app' (CHECK body + stored values) -----
ALTER TABLE "backups" DROP CONSTRAINT "backups_target_kind_xor";--> statement-breakpoint
UPDATE "backups" SET "target_kind" = 'app' WHERE "target_kind" = 'service';--> statement-breakpoint
UPDATE "backup_runs" SET "target_kind" = 'app' WHERE "target_kind" = 'service';--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_target_kind_xor" CHECK ((target_kind = 'database' and database_id is not null and app_id is null)
          or (target_kind = 'app' and app_id is not null and database_id is null));--> statement-breakpoint

-- Activity kind 'service' -> 'app' (the deployable-app activity token) ----
UPDATE "activities" SET "type" = 'app' WHERE "type" = 'service';--> statement-breakpoint

-- Volume discriminant "service" -> "app" (VolumeMount.type) ---------------
UPDATE "app_volumes" SET "type" = 'app' WHERE "type" = 'service';
