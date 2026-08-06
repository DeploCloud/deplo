-- The environment rung, on both axes: a role can be limited to ONE environment
-- of a project, and a person can be granted capabilities on one.
--
-- An Environment is where an app LIVES inside a project (ADR-0009 calls it the
-- membership axis), and until now it was invisible to every access mechanism:
-- not a node in the grant ladder, not a level of the scope tree, not a column in
-- any token scope. "Deploy to staging and nowhere near production" was
-- inexpressible, even though the apps carry the environment that would answer
-- it.
--
-- `environment_grants` is the direct clone of `folder_grants` / `project_grants`
-- / `app_grants`: one row per (environment, user, capability), both FKs CASCADE,
-- so dropping the environment or the account drops the grant. It also closes a
-- gap that predates scopes entirely - `ladder()` walks app → folders → project
-- and skips the environment the app actually sits in.
--
-- `team_role_scope_environments` is the fourth junction of a role's reach, beside
-- the three that landed in 0069.
--
-- THE BACKFILL is the part that matters on a live instance. `apps.environment_id`
-- is nullable, and every app filed into a project before 0020 has it null. The
-- Overview already treats those as living in the project's DEFAULT environment
-- (`app/(dashboard)/page.tsx` counts a null env as the default), so an
-- environment-shaped scope has to agree with what the user is looking at -
-- otherwise limiting a role to Production would silently exclude every app that
-- predates the column. This writes down what the UI has been implying.
CREATE TABLE "environment_grants" (
	"environment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "environment_grants_environment_id_user_id_capability_pk" PRIMARY KEY("environment_id","user_id","capability"),
	CONSTRAINT "environment_grants_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE cascade,
	CONSTRAINT "environment_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "environment_grants_user_idx" ON "environment_grants" ("user_id");
--> statement-breakpoint
CREATE TABLE "team_role_scope_environments" (
	"role_id" text NOT NULL,
	"environment_id" text NOT NULL,
	CONSTRAINT "team_role_scope_environments_role_id_environment_id_pk" PRIMARY KEY("role_id","environment_id"),
	CONSTRAINT "team_role_scope_environments_role_id_team_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "team_roles"("id") ON DELETE cascade,
	CONSTRAINT "team_role_scope_environments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "team_role_scope_environments_environment_idx" ON "team_role_scope_environments" ("environment_id");
--> statement-breakpoint
-- Legacy project apps land in their project's default environment, which is
-- where the Overview has been showing them all along.
UPDATE "apps" SET "environment_id" = (
	SELECT "e"."id" FROM "environments" "e"
	WHERE "e"."project_id" = "apps"."project_id" AND "e"."is_default"
	LIMIT 1
)
WHERE "apps"."project_id" IS NOT NULL AND "apps"."environment_id" IS NULL;
