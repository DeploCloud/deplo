-- Opening a security fix as a pull request is gone, and with it `open_security_prs`.
DROP TABLE "security_pull_requests" CASCADE;--> statement-breakpoint
DELETE FROM "membership_capabilities" WHERE "capability" = 'open_security_prs';--> statement-breakpoint
DELETE FROM "team_role_capabilities" WHERE "capability" = 'open_security_prs';--> statement-breakpoint
DELETE FROM "api_token_capabilities" WHERE "capability" = 'open_security_prs';--> statement-breakpoint
DELETE FROM "invite_capabilities" WHERE "capability" = 'open_security_prs';--> statement-breakpoint
DELETE FROM "registration_link_team_capabilities" WHERE "capability" = 'open_security_prs';--> statement-breakpoint
DELETE FROM "folder_grants" WHERE "capability" = 'open_security_prs';--> statement-breakpoint
DELETE FROM "project_grants" WHERE "capability" = 'open_security_prs';--> statement-breakpoint
DELETE FROM "app_grants" WHERE "capability" = 'open_security_prs';--> statement-breakpoint
DELETE FROM "environment_grants" WHERE "capability" = 'open_security_prs';
