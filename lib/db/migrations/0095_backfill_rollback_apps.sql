-- `rollback_apps` is a NEW capability (it gates putting an app back on a previous
-- deployment), so every capability row written before today is missing it and the
-- feature would be unreachable on every existing instance - including for the
-- founder, because "Owner grants everything" is a contract implemented by SEEDING
-- rows, not by deriving at check time. Same shape as 0080 and 0093.
--
-- THE RULE: grant it wherever `deploy_apps` already is.
--
-- Rolling back is strictly LESS power than deploying. Anyone holding `deploy_apps`
-- can already put any code they like on production - a revert commit and a
-- redeploy reaches the same running container, it just takes minutes and a git
-- push. Returning an app to a build that already shipped from this very instance
-- takes nothing new away from anybody.
--
-- Deliberately NOT `configure_apps`, which is the OTHER half of this feature: how
-- many rollbacks an app keeps is a retention setting (it decides how much disk the
-- app's images occupy on its server) and stays where every other app setting is.
-- Being able to go back and being able to decide how far back are two different
-- decisions, and an admin may well want to hand out only the first.
--
-- There is no user intent to preserve: nobody could have deliberately withheld a
-- capability that did not exist yesterday.

INSERT INTO "team_role_capabilities" ("role_id", "capability")
SELECT DISTINCT "role_id", 'rollback_apps'
FROM "team_role_capabilities"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- `membership_capabilities` is the flat set every authorization check actually
-- reads (a role edit re-writes it for its members in the same transaction), so it
-- must move with the roles or the grant above would be invisible.
INSERT INTO "membership_capabilities" ("membership_id", "capability")
SELECT DISTINCT "membership_id", 'rollback_apps'
FROM "membership_capabilities"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- All FOUR grant rungs, not just apps (ADR-0016): unlike `manage_crons` and
-- `delete_backups`, whose seed capabilities were app-shaped, `deploy_apps` is
-- grantable on a folder, a project and an environment too - "you look after
-- staging" has to keep meaning the same thing after today as it did before.
INSERT INTO "app_grants" ("app_id", "user_id", "capability")
SELECT DISTINCT "app_id", "user_id", 'rollback_apps'
FROM "app_grants"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "folder_grants" ("folder_id", "user_id", "capability")
SELECT DISTINCT "folder_id", "user_id", 'rollback_apps'
FROM "folder_grants"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "project_grants" ("project_id", "user_id", "capability")
SELECT DISTINCT "project_id", "user_id", 'rollback_apps'
FROM "project_grants"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "environment_grants" ("environment_id", "user_id", "capability")
SELECT DISTINCT "environment_id", "user_id", 'rollback_apps'
FROM "environment_grants"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;

-- DELIBERATELY NOT api_token_capabilities. A token is a principal whose
-- capabilities someone chose one by one when they minted it (ADR-0015); silently
-- widening what an existing secret can do is not a backfill, it is a privilege
-- escalation nobody asked for. A token that genuinely needs to roll an app back
-- can be re-issued with it ticked.
