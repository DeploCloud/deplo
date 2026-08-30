-- A managed database gets a placement, exactly like an App: it lives in an
-- Environment (and so on that Environment's network), or nowhere in particular
-- (and so on its team's). NULL is the pre-existing state; the boot sweep derives
-- a placement for the rows that only one Environment references.
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "environment_id" text;

DO $$
BEGIN
  ALTER TABLE "databases"
    ADD CONSTRAINT "databases_environment_id_environments_id_fk"
    FOREIGN KEY ("environment_id") REFERENCES "environments"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "databases_environment_idx" ON "databases" ("environment_id");
