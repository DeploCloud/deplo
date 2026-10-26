-- `open_security_prs` is new, so seed it wherever `deploy_apps` already is:
-- a pull request with a dependency's fix is a change to the app, like a deploy.
-- Not api_token_capabilities: widening an existing secret is an escalation (see 0095).
INSERT INTO "team_role_capabilities" ("role_id", "capability")
SELECT DISTINCT "role_id", 'open_security_prs'
FROM "team_role_capabilities"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "membership_capabilities" ("membership_id", "capability")
SELECT DISTINCT "membership_id", 'open_security_prs'
FROM "membership_capabilities"
WHERE "capability" = 'deploy_apps'
ON CONFLICT DO NOTHING;
