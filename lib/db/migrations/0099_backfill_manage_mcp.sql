-- `manage_mcp` is a NEW capability (it gates the two switches 0098 added, and the
-- Settings → MCP Server page they live on), so every capability row written before
-- today is missing it and the feature would be unreachable on every existing
-- instance - the Owner included, because "Owner grants everything" is a contract
-- implemented by SEEDING rows, not by deriving at check time. Same shape as 0080,
-- 0093 and 0095.
--
-- THE RULE: grant it wherever `manage_tokens` already is.
--
-- Deciding whether an AI agent may drive the team is the same class of decision as
-- minting the bearer token that lets it in: same credential, same API surface, same
-- blast radius. Anyone who can already hand out a token that redeploys production
-- gains nothing new here - the switch only decides whether the token they mint may
-- ALSO be spoken to over MCP.
--
-- Deliberately NOT `manage_team`. The MCP switch reads like a team setting, but the
-- decision it encodes is about credentials, and an admin who has been trusted with
-- tokens and not with team settings is exactly the person who should own it.
--
-- There is no user intent to preserve: nobody could have deliberately withheld a
-- capability that did not exist yesterday.
INSERT INTO "team_role_capabilities" ("role_id", "capability")
SELECT DISTINCT "role_id", 'manage_mcp'
FROM "team_role_capabilities"
WHERE "capability" = 'manage_tokens'
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- `membership_capabilities` is the flat set every authorization check actually
-- reads (a role edit re-writes it for its members in the same transaction), so it
-- must move with the roles or the grant above would be invisible.
INSERT INTO "membership_capabilities" ("membership_id", "capability")
SELECT DISTINCT "membership_id", 'manage_mcp'
FROM "membership_capabilities"
WHERE "capability" = 'manage_tokens'
ON CONFLICT DO NOTHING;

-- DELIBERATELY NOT the four node-grant tables (app/folder/project/environment).
-- `manage_mcp` is team-wide, exactly like the `manage_tokens` it is seeded from:
-- it is absent from PROJECT_SCOPED_CAPABILITIES and from the node-grantable set,
-- because "you look after staging" must never become a route to deciding who may
-- point an AI agent at the whole team.
--
-- DELIBERATELY NOT api_token_capabilities either. A token is a principal whose
-- capabilities someone chose one by one when they minted it (ADR-0015); silently
-- widening what an existing secret can do is not a backfill, it is a privilege
-- escalation nobody asked for.
