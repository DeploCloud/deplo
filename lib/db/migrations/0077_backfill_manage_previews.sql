-- `manage_previews` is a NEW capability (migration 0076 shipped the feature it
-- gates), and every capability row already in the database was written before it
-- existed. Without this backfill the feature is unreachable on every instance
-- that predates it — including for the founder, because "the Owner built-in
-- always grants everything" is a contract implemented by SEEDING rows, not by
-- deriving at check time. An owner would open Settings → Deployments and be told
-- they don't have permission to manage pull request previews.
--
-- THE RULE: grant it wherever `deploy_apps` is already held.
--
-- That is not a guess, it is the same expansion `presetOf` uses to answer "what
-- did this role already grant": `manage_previews` is carved out of the territory
-- the retired coarse `deploy` covered, alongside `deploy_apps`, and
-- LEGACY_CAPABILITY_EXPANSION lists both under it. There is also no user intent
-- to preserve — nobody could have deliberately withheld a capability that did
-- not exist yesterday — and anyone who can already deploy an app can already run
-- that repository's code on the host, which is exactly what a preview does.
--
-- Owner is covered by the same rule (it holds every capability, `deploy_apps`
-- included), which keeps this one statement instead of special-casing a
-- builtin_key that a team is free to rename.

INSERT INTO "team_role_capabilities" ("role_id", "capability")
SELECT "role_id", 'manage_previews'
FROM "team_role_capabilities"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- `membership_capabilities` is the flat set every authorization check actually
-- reads (a role edit re-writes it for its members in the same transaction), so
-- it must move with the roles or the grant above would be invisible.
INSERT INTO "membership_capabilities" ("membership_id", "capability")
SELECT "membership_id", 'manage_previews'
FROM "membership_capabilities"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Per-app grants (ADR-0016) get it too, for the same reason and with the same
-- rule: a node grant that already lets someone deploy THIS app should let them
-- run its pull requests, and nowhere else.
INSERT INTO "app_grants" ("app_id", "user_id", "capability")
SELECT "app_id", "user_id", 'manage_previews'
FROM "app_grants"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;

-- DELIBERATELY NOT api_token_capabilities. A token is a principal whose
-- capabilities someone chose one by one when they minted it (ADR-0015); silently
-- widening what an existing secret can do is not a backfill, it is a privilege
-- escalation nobody asked for. An old coarse name arriving from an API client
-- still expands through LEGACY_CAPABILITY_EXPANSION, and a token that genuinely
-- needs previews can be re-issued with them ticked.
