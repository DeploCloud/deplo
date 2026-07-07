-- ADR-0008: rename the deployable-app entity Project -> Service. Hand-authored
-- because drizzle-kit's non-interactive generate emits DROP+CREATE for a rename
-- (data loss). Tables, project_id columns, indexes, and the backups XOR CHECK
-- body + its stored 'project' target-kind values all migrate. IDs (prj_...) are
-- opaque and stay on the Service rows (no value rewrite). The agent wire
-- (deplo.project=<id> label, deplo-<slug> stack naming) is deliberately UNCHANGED
-- — it carries the Service id. FK/PK constraint names are left as-is (functional;
-- reconciled with the drizzle snapshot in a follow-up) — nothing reads them.

-- Tables -----------------------------------------------------------------
ALTER TABLE "projects" RENAME TO "services";--> statement-breakpoint
ALTER TABLE "project_build" RENAME TO "service_build";--> statement-breakpoint
ALTER TABLE "project_build_method_settings" RENAME TO "service_build_method_settings";--> statement-breakpoint
ALTER TABLE "project_dev" RENAME TO "service_dev";--> statement-breakpoint
ALTER TABLE "project_volumes" RENAME TO "service_volumes";--> statement-breakpoint
ALTER TABLE "project_mounts" RENAME TO "service_mounts";--> statement-breakpoint
ALTER TABLE "project_basic_auth_users" RENAME TO "service_basic_auth_users";--> statement-breakpoint
ALTER TABLE "team_project_order" RENAME TO "team_service_order";--> statement-breakpoint
ALTER TABLE "shared_env_group_projects" RENAME TO "shared_env_group_services";--> statement-breakpoint

-- Columns project_id -> service_id ---------------------------------------
ALTER TABLE "service_build" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "service_build_method_settings" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "service_dev" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "service_volumes" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "service_mounts" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "service_basic_auth_users" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "deployments" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "env_vars" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "domains" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "dev_ssh_user" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "team_service_order" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "backups" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "backup_runs" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "activities" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint
ALTER TABLE "shared_env_group_services" RENAME COLUMN "project_id" TO "service_id";--> statement-breakpoint

-- Indexes ----------------------------------------------------------------
ALTER INDEX "projects_slug_uq" RENAME TO "services_slug_uq";--> statement-breakpoint
ALTER INDEX "projects_team_idx" RENAME TO "services_team_idx";--> statement-breakpoint
ALTER INDEX "projects_folder_idx" RENAME TO "services_folder_idx";--> statement-breakpoint
ALTER INDEX "env_vars_project_key_uq" RENAME TO "env_vars_service_key_uq";--> statement-breakpoint
ALTER INDEX "domains_project_idx" RENAME TO "domains_service_idx";--> statement-breakpoint
ALTER INDEX "deployments_project_created_idx" RENAME TO "deployments_service_created_idx";--> statement-breakpoint
ALTER INDEX "shared_env_group_projects_project_idx" RENAME TO "shared_env_group_services_service_idx";--> statement-breakpoint
ALTER INDEX "project_basic_auth_users_project_username_uq" RENAME TO "service_basic_auth_users_service_username_uq";--> statement-breakpoint
ALTER INDEX "project_basic_auth_users_project_idx" RENAME TO "service_basic_auth_users_service_idx";--> statement-breakpoint

-- backups target_kind 'project' -> 'service' (CHECK body + stored values) --
ALTER TABLE "backups" DROP CONSTRAINT "backups_target_kind_xor";--> statement-breakpoint
UPDATE "backups" SET "target_kind" = 'service' WHERE "target_kind" = 'project';--> statement-breakpoint
UPDATE "backup_runs" SET "target_kind" = 'service' WHERE "target_kind" = 'project';--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_target_kind_xor" CHECK ((target_kind = 'database' and database_id is not null and service_id is null)
          or (target_kind = 'service' and service_id is not null and database_id is null));--> statement-breakpoint

-- Activity kind 'project' -> 'service' (the deployable-app activity token) --
UPDATE "activities" SET "type" = 'service' WHERE "type" = 'project';

--> statement-breakpoint
-- Volume discriminant "project" -> "service" (VolumeMount.type)
UPDATE "service_volumes" SET "type" = 'service' WHERE "type" = 'project';
