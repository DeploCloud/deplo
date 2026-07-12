-- ADR-0010: unified shared variables. One `shared_env_vars` row is an individual
-- shared variable owned by a team, reaching apps through three sharing MODES
-- (team-wide / environment[] / project[] whitelist) plus a per-app link. This
-- replaces the shared-env GROUP model, environment-scoped vars, and team-global
-- vars — all three are exploded/converted into shared vars below so no app loses a
-- variable and resolved values stay identical (see lib/deploy/env-resolve.ts).
--
-- This migration CREATES the new tables and backfills; the legacy tables are
-- dropped separately in 0028 so a parity test can replay to 0027 with them intact.

CREATE TABLE "shared_env_vars" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"key" text NOT NULL,
	"value_enc" text NOT NULL,
	"type" text NOT NULL,
	"team_wide" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_env_var_targets" (
	"var_id" text NOT NULL,
	"target" text NOT NULL,
	CONSTRAINT "shared_env_var_targets_var_id_target_pk" PRIMARY KEY("var_id","target")
);
--> statement-breakpoint
CREATE TABLE "shared_env_var_environments" (
	"var_id" text NOT NULL,
	"environment_id" text NOT NULL,
	CONSTRAINT "shared_env_var_environments_var_id_environment_id_pk" PRIMARY KEY("var_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "shared_env_var_projects" (
	"var_id" text NOT NULL,
	"project_id" text NOT NULL,
	CONSTRAINT "shared_env_var_projects_var_id_project_id_pk" PRIMARY KEY("var_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "shared_env_var_apps" (
	"var_id" text NOT NULL,
	"app_id" text NOT NULL,
	CONSTRAINT "shared_env_var_apps_var_id_app_id_pk" PRIMARY KEY("var_id","app_id")
);
--> statement-breakpoint
ALTER TABLE "shared_env_vars" ADD CONSTRAINT "shared_env_vars_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_var_targets" ADD CONSTRAINT "shared_env_var_targets_var_id_shared_env_vars_id_fk" FOREIGN KEY ("var_id") REFERENCES "shared_env_vars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_var_environments" ADD CONSTRAINT "shared_env_var_environments_var_id_shared_env_vars_id_fk" FOREIGN KEY ("var_id") REFERENCES "shared_env_vars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_var_environments" ADD CONSTRAINT "shared_env_var_environments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_var_projects" ADD CONSTRAINT "shared_env_var_projects_var_id_shared_env_vars_id_fk" FOREIGN KEY ("var_id") REFERENCES "shared_env_vars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_var_projects" ADD CONSTRAINT "shared_env_var_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_var_apps" ADD CONSTRAINT "shared_env_var_apps_var_id_shared_env_vars_id_fk" FOREIGN KEY ("var_id") REFERENCES "shared_env_vars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_var_apps" ADD CONSTRAINT "shared_env_var_apps_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_env_vars_team_idx" ON "shared_env_vars" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "shared_env_vars_team_key_idx" ON "shared_env_vars" USING btree ("team_id","key");--> statement-breakpoint
CREATE INDEX "shared_env_var_environments_env_idx" ON "shared_env_var_environments" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "shared_env_var_projects_project_idx" ON "shared_env_var_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "shared_env_var_apps_app_idx" ON "shared_env_var_apps" USING btree ("app_id");--> statement-breakpoint

-- ============================================================================
-- Backfill / conversion of the three legacy shared systems. Deterministic,
-- source-tagged ids (svar_<md5(tag:source-key)>) so the junction INSERTs recompute
-- the same id and join back without a random-id round-trip. tags: tg=team-global,
-- ee=environment var, sg=shared-group var-key — distinct tags prevent collisions.
-- ============================================================================

-- (a) team-global env var -> team-wide shared var (+ copy its targets)
INSERT INTO "shared_env_vars" ("id","team_id","key","value_enc","type","team_wide","created_at","updated_at")
SELECT 'svar_' || substr(md5('tg:' || g.id), 1, 16), g."team_id", g."key", g."value_enc", g."type", true, g."created_at", g."updated_at"
FROM "team_global_env_vars" g;--> statement-breakpoint
INSERT INTO "shared_env_var_targets" ("var_id","target")
SELECT 'svar_' || substr(md5('tg:' || t."env_var_id"), 1, 16), t."target"
FROM "team_global_env_var_targets" t;--> statement-breakpoint

-- (b) environment-scoped var -> environment-mode shared var. Targets = ALL three
-- to reproduce membership (the app LIVES in the env, so it applied to every
-- runtime). team_id resolved via the environment's project.
INSERT INTO "shared_env_vars" ("id","team_id","key","value_enc","type","team_wide","created_at","updated_at")
SELECT 'svar_' || substr(md5('ee:' || e.id), 1, 16), p."team_id", e."key", e."value_enc", e."type", false, e."created_at", e."updated_at"
FROM "environment_env_vars" e
JOIN "environments" env ON env.id = e."environment_id"
JOIN "projects" p ON p.id = env."project_id";--> statement-breakpoint
INSERT INTO "shared_env_var_environments" ("var_id","environment_id")
SELECT 'svar_' || substr(md5('ee:' || e.id), 1, 16), e."environment_id"
FROM "environment_env_vars" e;--> statement-breakpoint
INSERT INTO "shared_env_var_targets" ("var_id","target")
SELECT 'svar_' || substr(md5('ee:' || e.id), 1, 16), tt.target
FROM "environment_env_vars" e
CROSS JOIN (VALUES ('production'),('preview'),('development')) AS tt(target);--> statement-breakpoint

-- (c) shared-group var-key -> per-app-link shared var. Links = the group's apps;
-- targets = the group's targets, or ALL three when the group had none (the old
-- groupTargets() default). Mapping to a per-app LINK (not team-wide/project) is
-- what reproduces both the exact attached-app set AND the "overrides app-own"
-- precedence the old shared groups had.
INSERT INTO "shared_env_vars" ("id","team_id","key","value_enc","type","team_wide","created_at","updated_at")
SELECT 'svar_' || substr(md5('sg:' || v."group_id" || ':' || v."key"), 1, 16), g."team_id", v."key", v."value_enc", v."type", false, g."created_at", g."updated_at"
FROM "shared_env_group_vars" v
JOIN "shared_env_groups" g ON g.id = v."group_id";--> statement-breakpoint
INSERT INTO "shared_env_var_apps" ("var_id","app_id")
SELECT DISTINCT 'svar_' || substr(md5('sg:' || v."group_id" || ':' || v."key"), 1, 16), a."app_id"
FROM "shared_env_group_vars" v
JOIN "shared_env_group_apps" a ON a."group_id" = v."group_id";--> statement-breakpoint
INSERT INTO "shared_env_var_targets" ("var_id","target")
SELECT 'svar_' || substr(md5('sg:' || v."group_id" || ':' || v."key"), 1, 16), t."target"
FROM "shared_env_group_vars" v
JOIN "shared_env_group_targets" t ON t."group_id" = v."group_id";--> statement-breakpoint
INSERT INTO "shared_env_var_targets" ("var_id","target")
SELECT 'svar_' || substr(md5('sg:' || v."group_id" || ':' || v."key"), 1, 16), tt.target
FROM "shared_env_group_vars" v
CROSS JOIN (VALUES ('production'),('preview'),('development')) AS tt(target)
WHERE NOT EXISTS (SELECT 1 FROM "shared_env_group_targets" t WHERE t."group_id" = v."group_id");
