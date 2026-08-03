-- A token's scope becomes a TREE: teams, then projects, then individual apps.
--
-- 0061 gave a token its own capabilities and a project scope. That scope was too
-- shallow in both directions: a token was pinned to exactly ONE team (whichever
-- it happened to be created in, with no way to say "these two teams" or "every
-- team I belong to"), and inside a project it was all-or-nothing — there was no
-- way to hand a CI job one app.
--
-- Now the scope is the tree the editor draws. One row per TICKED node, at
-- whatever depth it was ticked:
--   api_token_teams    — this whole team: every project, every app, and the
--                        team-wide settings its capabilities allow.
--   api_token_projects — this whole project: every app in it, now and later.
--   api_token_apps     — exactly this app.
-- The token's team set is derived (a project knows its team, an app knows its
-- team), so nothing is denormalized and a node deleted anywhere simply drops out.
--
-- `project_scoped` becomes `scoped` because it no longer only means projects. It
-- still carries the INTENT: rows cascade away when their node is deleted, and
-- without the flag an emptied scope would read as "unscoped" and silently widen
-- the token to everything.
--
-- Depth is what strips permissions, breadth is not. A token holding two WHOLE
-- teams keeps every capability it was given in both. A token narrowed to a
-- project or an app inside a team loses that team's team-wide capabilities
-- (members, roles, registries, databases) — there is no per-project version of
-- them. So "which teams" and "how much of a team" stay two separate questions.
--
-- This migration changes NOBODY's access. Every token that exists is given an
-- explicit WHOLE-TEAM row for the team it was created in and marked scoped, which
-- is exactly the team it was already pinned to; a token that was already
-- project-scoped keeps its project rows untouched. "Unscoped" now means the new
-- and deliberate "everything I can access", and no existing row means it.
ALTER TABLE "api_tokens" RENAME COLUMN "project_scoped" TO "scoped";
--> statement-breakpoint
CREATE TABLE "api_token_teams" (
	"token_id" text NOT NULL,
	"team_id" text NOT NULL,
	CONSTRAINT "api_token_teams_token_id_team_id_pk" PRIMARY KEY("token_id","team_id"),
	CONSTRAINT "api_token_teams_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "api_tokens"("id") ON DELETE cascade,
	CONSTRAINT "api_token_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "api_token_teams_team_idx" ON "api_token_teams" ("team_id");
--> statement-breakpoint
CREATE TABLE "api_token_apps" (
	"token_id" text NOT NULL,
	"app_id" text NOT NULL,
	CONSTRAINT "api_token_apps_token_id_app_id_pk" PRIMARY KEY("token_id","app_id"),
	CONSTRAINT "api_token_apps_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "api_tokens"("id") ON DELETE cascade,
	CONSTRAINT "api_token_apps_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "api_token_apps_app_idx" ON "api_token_apps" ("app_id");
--> statement-breakpoint
-- Pin every previously-unscoped token to the ONE team it could already reach.
-- Without this row it would come out of the migration meaning "every team its
-- creator belongs to", which is a widening nobody asked for.
INSERT INTO "api_token_teams" ("token_id", "team_id")
SELECT t."id", t."team_id" FROM "api_tokens" t WHERE NOT t."scoped"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "api_tokens" SET "scoped" = true;
