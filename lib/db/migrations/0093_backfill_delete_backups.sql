-- `delete_backups` is a NEW capability (it gates the panel's per-backup Delete),
-- so every capability row written before today is missing it and the feature
-- would be unreachable on every existing instance - including for the founder,
-- because "Owner grants everything" is a contract implemented by SEEDING rows,
-- not by deriving at check time. Same shape as 0080.
--
-- THE RULE: grant it wherever the TARGET may already be destroyed - `delete_apps`
-- OR `delete_databases`.
--
-- That is the rule the bulk path already encodes ("whoever may destroy the
-- database may destroy its backups; nobody else"): deleting an app or a database
-- ALREADY sweeps every artifact it has, so anyone holding those verbs can delete
-- these files today, wholesale and with no per-file step. Handing them the
-- narrower one takes nothing new away from anybody.
--
-- Deliberately NOT `manage_backups`. That one reads "create, edit, disable and
-- run backup schedules" and is handed out on that reading; seeding from it would
-- give permanent, unrecoverable deletion of a restore point to everyone trusted
-- to set up a nightly dump. Nor `restore_backups`: overwriting a target from a
-- backup is destructive to the TARGET, but it leaves every restore point intact.
--
-- There is no user intent to preserve: nobody could have deliberately withheld a
-- capability that did not exist yesterday.

INSERT INTO "team_role_capabilities" ("role_id", "capability")
SELECT DISTINCT "role_id", 'delete_backups'
FROM "team_role_capabilities"
WHERE "capability" IN ('delete_apps', 'delete_databases')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- `membership_capabilities` is the flat set every authorization check actually
-- reads (a role edit re-writes it for its members in the same transaction), so
-- it must move with the roles or the grant above would be invisible.
INSERT INTO "membership_capabilities" ("membership_id", "capability")
SELECT DISTINCT "membership_id", 'delete_backups'
FROM "membership_capabilities"
WHERE "capability" IN ('delete_apps', 'delete_databases')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Per-app grants (ADR-0016) get it too, with the same rule scoped to the node:
-- a grant that already lets someone delete THIS app lets them delete its
-- backups, and nowhere else. `delete_databases` is not filtered here because
-- databases have no node grants - only the app capability can appear.
INSERT INTO "app_grants" ("app_id", "user_id", "capability")
SELECT DISTINCT "app_id", "user_id", 'delete_backups'
FROM "app_grants"
WHERE "capability" = 'delete_apps'
ON CONFLICT DO NOTHING;

-- DELIBERATELY NOT api_token_capabilities. A token is a principal whose
-- capabilities someone chose one by one when they minted it (ADR-0015); silently
-- widening what an existing secret can do is not a backfill, it is a privilege
-- escalation nobody asked for. A token that genuinely needs to delete backups
-- can be re-issued with it ticked.
