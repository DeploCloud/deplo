-- `move_databases` is new, so seed it wherever `delete_databases` already is:
-- handing a database to another team takes it from this one, like deleting it.
-- Not api_token_capabilities: widening an existing secret is an escalation (see 0095).
INSERT INTO "team_role_capabilities" ("role_id", "capability")
SELECT DISTINCT "role_id", 'move_databases'
FROM "team_role_capabilities"
WHERE "capability" = 'delete_databases'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "membership_capabilities" ("membership_id", "capability")
SELECT DISTINCT "membership_id", 'move_databases'
FROM "membership_capabilities"
WHERE "capability" = 'delete_databases'
ON CONFLICT DO NOTHING;
