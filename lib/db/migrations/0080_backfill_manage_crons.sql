-- `manage_crons` is a NEW capability (0079 shipped the feature it gates), so
-- every capability row written before today is missing it and the feature would
-- be unreachable on every existing instance - including for the founder, because
-- "Owner grants everything" is a contract implemented by SEEDING rows, not by
-- deriving at check time.
--
-- THE RULE: grant it wherever CONSOLE ACCESS is already held - `open_app_console`
-- OR `open_database_console`.
--
-- This deliberately differs from 0077, which seeded `manage_previews` from
-- `deploy_apps`. A cron job runs an arbitrary command inside a container as the
-- container's user: it is remote code execution on a schedule, and the
-- capability that already means exactly that is the console one. Seeding from
-- `deploy_apps` would hand scheduled command execution to everyone who can ship
-- an app - a strictly larger set, and an escalation nobody asked for.
--
-- Both console capabilities are the source because ONE `manage_crons` governs
-- both target kinds. Someone who can only open an app console gets it (and the
-- data layer still refuses their database jobs, which are additionally gated on
-- `open_database_console`); someone who can only open a database console gets it
-- for the same reason on the other side. Taking only one of the two would leave
-- half the audience unable to use the feature they already have the equivalent
-- power for.
--
-- There is no user intent to preserve: nobody could have deliberately withheld a
-- capability that did not exist yesterday.

INSERT INTO "team_role_capabilities" ("role_id", "capability")
SELECT DISTINCT "role_id", 'manage_crons'
FROM "team_role_capabilities"
WHERE "capability" IN ('open_app_console', 'open_database_console')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- `membership_capabilities` is the flat set every authorization check actually
-- reads (a role edit re-writes it for its members in the same transaction), so
-- it must move with the roles or the grant above would be invisible.
INSERT INTO "membership_capabilities" ("membership_id", "capability")
SELECT DISTINCT "membership_id", 'manage_crons'
FROM "membership_capabilities"
WHERE "capability" IN ('open_app_console', 'open_database_console')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Per-app grants (ADR-0016) get it too, with the same rule scoped to the node:
-- a grant that already lets someone open THIS app's console lets them schedule a
-- command in it, and nowhere else. `open_database_console` is not filtered here
-- because databases have no node grants - only the app capability can appear.
INSERT INTO "app_grants" ("app_id", "user_id", "capability")
SELECT DISTINCT "app_id", "user_id", 'manage_crons'
FROM "app_grants"
WHERE "capability" = 'open_app_console'
ON CONFLICT DO NOTHING;

-- DELIBERATELY NOT api_token_capabilities. A token is a principal whose
-- capabilities someone chose one by one when they minted it (ADR-0015); silently
-- widening what an existing secret can do is not a backfill, it is a privilege
-- escalation nobody asked for - and this particular widening would be "this key
-- can now run any command on your servers, on a timer". A token that genuinely
-- needs cron jobs can be re-issued with them ticked.
