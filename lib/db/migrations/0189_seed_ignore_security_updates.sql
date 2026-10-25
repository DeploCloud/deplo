-- `ignore_security_updates` is new, so seed it wherever `manage_team` already is:
-- silencing a security update is a team-level call, made by whoever runs the team.
-- Not api_token_capabilities: widening an existing secret is an escalation (see 0095).
INSERT INTO "team_role_capabilities" ("role_id", "capability")
SELECT DISTINCT "role_id", 'ignore_security_updates'
FROM "team_role_capabilities"
WHERE "capability" = 'manage_team'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "membership_capabilities" ("membership_id", "capability")
SELECT DISTINCT "membership_id", 'ignore_security_updates'
FROM "membership_capabilities"
WHERE "capability" = 'manage_team'
ON CONFLICT DO NOTHING;
