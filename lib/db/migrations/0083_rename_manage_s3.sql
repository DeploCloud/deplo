-- `manage_s3` becomes `manage_backup_destinations`.
--
-- The capability now governs two kinds of destination, only one of which is S3,
-- and a permission named after an implementation detail is a permission an admin
-- has to translate every time they grant it. Same power, honest name.
--
-- Nobody's access changes: every stored row is renamed in place. Applies to every
-- table that stores a capability, exactly as 0056 did. ON CONFLICT DO NOTHING
-- makes it re-runnable, and the DELETE clears an old row whose new-world twin
-- already existed.
--
-- LEGACY_CAPABILITY_EXPANSION in lib/capabilities.ts keeps translating `manage_s3`
-- arriving from an API client, so a token minted before this still works. The two
-- must agree; SQL cannot import TypeScript, which is why the mapping is written
-- twice.
INSERT INTO "membership_capabilities" ("membership_id", "capability")
SELECT DISTINCT t."membership_id", 'manage_backup_destinations' FROM "membership_capabilities" t
  WHERE t."capability" = 'manage_s3'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "team_role_capabilities" ("role_id", "capability")
SELECT DISTINCT t."role_id", 'manage_backup_destinations' FROM "team_role_capabilities" t
  WHERE t."capability" = 'manage_s3'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "folder_grants" ("folder_id", "user_id", "capability")
SELECT DISTINCT t."folder_id", t."user_id", 'manage_backup_destinations' FROM "folder_grants" t
  WHERE t."capability" = 'manage_s3'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "project_grants" ("project_id", "user_id", "capability")
SELECT DISTINCT t."project_id", t."user_id", 'manage_backup_destinations' FROM "project_grants" t
  WHERE t."capability" = 'manage_s3'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "invite_capabilities" ("invite_id", "capability")
SELECT DISTINCT t."invite_id", 'manage_backup_destinations' FROM "invite_capabilities" t
  WHERE t."capability" = 'manage_s3'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "registration_link_team_capabilities" ("link_team_id", "capability")
SELECT DISTINCT t."link_team_id", 'manage_backup_destinations' FROM "registration_link_team_capabilities" t
  WHERE t."capability" = 'manage_s3'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "membership_capabilities" WHERE "capability" = 'manage_s3';
--> statement-breakpoint
DELETE FROM "team_role_capabilities" WHERE "capability" = 'manage_s3';
--> statement-breakpoint
DELETE FROM "folder_grants" WHERE "capability" = 'manage_s3';
--> statement-breakpoint
DELETE FROM "project_grants" WHERE "capability" = 'manage_s3';
--> statement-breakpoint
DELETE FROM "invite_capabilities" WHERE "capability" = 'manage_s3';
--> statement-breakpoint
DELETE FROM "registration_link_team_capabilities" WHERE "capability" = 'manage_s3';
