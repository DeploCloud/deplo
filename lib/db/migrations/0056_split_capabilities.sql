-- The eight coarse capabilities become forty named permissions.
--
-- `deploy` meant create an app, ship it, stop it, delete it, shell into it, and
-- make folders, projects and environments - thirteen different powers behind one
-- word. `manage_infra` meant every database, backup, S3 bucket, registry, Git
-- connection and API token at once. So "can deploy but must not delete", "can read
-- files but not write them", "can run backups but never restore one" were not
-- things a team could say. Now each of those is its own permission, and a Role is
-- the named set (see lib/capabilities.ts for the catalog and the categories the
-- editor browses them by).
--
-- This migration changes NOBODY's access. Every stored row is expanded into
-- exactly the permissions its old name already implied - the mapping is
-- LEGACY_CAPABILITY_EXPANSION in lib/capabilities.ts, and the two must agree
-- (the same table, written twice, is why: SQL cannot import TypeScript, and a
-- one-shot expansion must not depend on the app booting first).
--
-- Five names survive unchanged because they were already one action -
-- view, manage_domains, manage_env, manage_members, manage_team, so they are
-- present on both sides of the mapping and are NOT deleted. Only `deploy`,
-- `manage_files` and `manage_infra` disappear.
--
-- Applies to every table that stores a capability: memberships, team roles,
-- per-folder and per-project grants, invites and registration links. A row that
-- already holds a new-world name is left alone (the inserts are ON CONFLICT DO
-- NOTHING), so re-running this is a no-op.
-- A plain temporary table, NOT `ON COMMIT DROP`: the migrator applies a file's
-- statements one at a time, so a table that dies with the first statement's
-- transaction is gone before the second one reads it. It is per-session either
-- way, and dropped explicitly at the end.
CREATE TEMPORARY TABLE capability_split (old text NOT NULL, new text NOT NULL);
--> statement-breakpoint
INSERT INTO capability_split (old, new) VALUES
  ('view', 'view'),
  ('view', 'view_logs'),
  ('view', 'view_metrics'),
  ('view', 'view_activity'),
  ('deploy', 'create_apps'),
  ('deploy', 'deploy_apps'),
  ('deploy', 'control_apps'),
  ('deploy', 'configure_apps'),
  ('deploy', 'delete_apps'),
  ('deploy', 'move_apps'),
  ('deploy', 'open_app_console'),
  ('deploy', 'create_folders'),
  ('deploy', 'organize_folders'),
  ('deploy', 'delete_folders'),
  ('deploy', 'create_projects'),
  ('deploy', 'organize_projects'),
  ('deploy', 'delete_projects'),
  ('deploy', 'manage_environments'),
  ('manage_domains', 'manage_domains'),
  ('manage_domains', 'manage_basic_auth'),
  ('manage_env', 'manage_env'),
  ('manage_env', 'reveal_secrets'),
  ('manage_files', 'read_app_files'),
  ('manage_files', 'write_app_files'),
  ('manage_infra', 'create_databases'),
  ('manage_infra', 'configure_databases'),
  ('manage_infra', 'control_databases'),
  ('manage_infra', 'delete_databases'),
  ('manage_infra', 'open_database_console'),
  ('manage_infra', 'manage_backups'),
  ('manage_infra', 'restore_backups'),
  ('manage_infra', 'manage_s3'),
  ('manage_infra', 'manage_registries'),
  ('manage_infra', 'manage_git'),
  ('manage_infra', 'manage_tokens'),
  ('manage_infra', 'manage_notifications'),
  ('manage_infra', 'manage_monitoring'),
  ('manage_members', 'manage_members'),
  ('manage_members', 'manage_roles'),
  ('manage_team', 'manage_team'),
  ('manage_team', 'delete_team');
--> statement-breakpoint
INSERT INTO "membership_capabilities" ("membership_id", "capability")
SELECT DISTINCT t."membership_id", s.new FROM "membership_capabilities" t
  JOIN capability_split s ON s.old = t."capability"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "team_role_capabilities" ("role_id", "capability")
SELECT DISTINCT t."role_id", s.new FROM "team_role_capabilities" t
  JOIN capability_split s ON s.old = t."capability"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "folder_grants" ("folder_id", "user_id", "capability")
SELECT DISTINCT t."folder_id", t."user_id", s.new FROM "folder_grants" t
  JOIN capability_split s ON s.old = t."capability"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "project_grants" ("project_id", "user_id", "capability")
SELECT DISTINCT t."project_id", t."user_id", s.new FROM "project_grants" t
  JOIN capability_split s ON s.old = t."capability"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "invite_capabilities" ("invite_id", "capability")
SELECT DISTINCT t."invite_id", s.new FROM "invite_capabilities" t
  JOIN capability_split s ON s.old = t."capability"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "registration_link_team_capabilities" ("link_team_id", "capability")
SELECT DISTINCT t."link_team_id", s.new FROM "registration_link_team_capabilities" t
  JOIN capability_split s ON s.old = t."capability"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Retire the three names that no longer exist. The other five are current
-- capabilities in their own right and stay exactly where they are.
DELETE FROM "membership_capabilities" WHERE "capability" IN ('deploy', 'manage_files', 'manage_infra');
--> statement-breakpoint
DELETE FROM "team_role_capabilities" WHERE "capability" IN ('deploy', 'manage_files', 'manage_infra');
--> statement-breakpoint
DELETE FROM "folder_grants" WHERE "capability" IN ('deploy', 'manage_files', 'manage_infra');
--> statement-breakpoint
DELETE FROM "project_grants" WHERE "capability" IN ('deploy', 'manage_files', 'manage_infra');
--> statement-breakpoint
DELETE FROM "invite_capabilities" WHERE "capability" IN ('deploy', 'manage_files', 'manage_infra');
--> statement-breakpoint
DELETE FROM "registration_link_team_capabilities" WHERE "capability" IN ('deploy', 'manage_files', 'manage_infra');
--> statement-breakpoint
DROP TABLE capability_split;
