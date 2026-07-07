-- ADR-0008 Phase 3: environment-scoped shared env vars. A variable stored on an
-- Environment is injected into EVERY service of that environment's Project, in
-- that environment's context (kind bridges to the runtime until the pipeline is
-- fully environment-parameterized). Additive: no existing table changes.

CREATE TABLE "environment_env_vars" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"key" text NOT NULL,
	"value_enc" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_env_vars" ADD CONSTRAINT "environment_env_vars_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_env_vars_environment_key_uq" ON "environment_env_vars" USING btree ("environment_id","key");--> statement-breakpoint
CREATE INDEX "environment_env_vars_environment_idx" ON "environment_env_vars" USING btree ("environment_id");--> statement-breakpoint
-- Backfill (ADR-0008 phased plan): a project created between migrations 0016 and
-- 0017 predates Environment seeding and has no rows — give it the standard three
-- (Production default), so every project can hold environment variables. Ids use
-- md5(random) instead of pgcrypto so the statement runs on any Postgres (pglite
-- included); the environ_ prefix matches newId("environ").
INSERT INTO "environments" ("id", "project_id", "name", "slug", "kind", "git_branch", "is_default", "position", "created_at", "updated_at")
SELECT 'environ_' || substr(md5(random()::text || p.id || s.slug), 1, 16),
       p.id, s.name, s.slug, s.kind, '', s.is_default, s.position, now(), now()
FROM "projects" p
CROSS JOIN (VALUES
  ('Development', 'development', 'development', false, 0),
  ('Preview', 'preview', 'preview', false, 1),
  ('Production', 'production', 'production', true, 2)
) AS s(name, slug, kind, is_default, position)
WHERE NOT EXISTS (SELECT 1 FROM "environments" e WHERE e."project_id" = p.id);
