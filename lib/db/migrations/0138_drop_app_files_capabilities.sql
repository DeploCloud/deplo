-- The Files browser is gone, and with it the two capabilities that gated it.
-- A File volume's body is still editable in Settings → Storage, under
-- `configure_apps` like the rest of that page, so nobody loses an ability here.
DELETE FROM "membership_capabilities" WHERE "capability" IN ('read_app_files', 'write_app_files');--> statement-breakpoint
DELETE FROM "team_role_capabilities" WHERE "capability" IN ('read_app_files', 'write_app_files');--> statement-breakpoint
DELETE FROM "api_token_capabilities" WHERE "capability" IN ('read_app_files', 'write_app_files');--> statement-breakpoint
DELETE FROM "invite_capabilities" WHERE "capability" IN ('read_app_files', 'write_app_files');--> statement-breakpoint
DELETE FROM "registration_link_team_capabilities" WHERE "capability" IN ('read_app_files', 'write_app_files');--> statement-breakpoint
DELETE FROM "folder_grants" WHERE "capability" IN ('read_app_files', 'write_app_files');--> statement-breakpoint
DELETE FROM "project_grants" WHERE "capability" IN ('read_app_files', 'write_app_files');--> statement-breakpoint
DELETE FROM "app_grants" WHERE "capability" IN ('read_app_files', 'write_app_files');--> statement-breakpoint
DELETE FROM "environment_grants" WHERE "capability" IN ('read_app_files', 'write_app_files');
