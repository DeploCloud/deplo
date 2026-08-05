-- A ROLE can reach part of the team instead of all of it.
--
-- Until now a role answered exactly one question — what may its holders DO —
-- and the answer applied to every app in the team. The only way to say "this
-- person works on Prod and nothing else" was a per-folder grant (ADR-0016),
-- which is a per-PERSON act: a team that wanted the same boundary for five
-- people had to repeat it five times, and nothing on the roles page admitted the
-- boundary existed.
--
-- So a role gains the second axis the API token already has (ADR-0015): REACH.
-- Nothing ticked is unrestricted, which is every role that exists today and
-- every role created from now on until someone says otherwise. This migration
-- therefore changes nothing about any running instance; it only makes the
-- statement expressible.
--
-- `scoped` is the INTENT, and it is a stored boolean rather than a derived
-- "are there any rows" for the reason `api_tokens.scoped` gives: the junctions
-- below CASCADE, so deleting the last project a role was limited to would empty
-- the scope, and an emptied scope with no flag reads as "no scope at all" —
-- silently widening the role to the whole team at the exact moment somebody
-- deleted something. Scoped with zero rows means "reaches nothing".
--
-- Three junctions, not one polymorphic `(node_kind, node_id)` table: a Postgres
-- PRIMARY KEY cannot contain a nullable column, and a real foreign key per kind
-- is what makes the cascade the entire cleanup story. Same shape, same reasons,
-- as `api_token_projects` / `_folders` / `_apps`.
--
-- Environments are deliberately absent here. An app filed into a folder has its
-- `environment_id` cleared (ADR-0009's one-home rule), so an environment-shaped
-- scope needs that seam settled first; it lands in its own migration.
ALTER TABLE "team_roles" ADD COLUMN "scoped" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "team_role_scope_projects" (
	"role_id" text NOT NULL,
	"project_id" text NOT NULL,
	CONSTRAINT "team_role_scope_projects_role_id_project_id_pk" PRIMARY KEY("role_id","project_id"),
	CONSTRAINT "team_role_scope_projects_role_id_team_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "team_roles"("id") ON DELETE cascade,
	CONSTRAINT "team_role_scope_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "team_role_scope_projects_project_idx" ON "team_role_scope_projects" ("project_id");
--> statement-breakpoint
CREATE TABLE "team_role_scope_folders" (
	"role_id" text NOT NULL,
	"folder_id" text NOT NULL,
	CONSTRAINT "team_role_scope_folders_role_id_folder_id_pk" PRIMARY KEY("role_id","folder_id"),
	CONSTRAINT "team_role_scope_folders_role_id_team_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "team_roles"("id") ON DELETE cascade,
	CONSTRAINT "team_role_scope_folders_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "team_role_scope_folders_folder_idx" ON "team_role_scope_folders" ("folder_id");
--> statement-breakpoint
CREATE TABLE "team_role_scope_apps" (
	"role_id" text NOT NULL,
	"app_id" text NOT NULL,
	CONSTRAINT "team_role_scope_apps_role_id_app_id_pk" PRIMARY KEY("role_id","app_id"),
	CONSTRAINT "team_role_scope_apps_role_id_team_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "team_roles"("id") ON DELETE cascade,
	CONSTRAINT "team_role_scope_apps_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "team_role_scope_apps_app_idx" ON "team_role_scope_apps" ("app_id");
