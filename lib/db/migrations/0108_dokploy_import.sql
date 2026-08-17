-- Import from Dokploy — the run and its report, kept after the tab is closed.
--
-- The importer reads a Dokploy instance over its HTTP API and creates the deplo
-- equivalents: a Project per project, an Environment per environment, an App per
-- application or compose stack, a Database per engine row, plus domains, env
-- vars, mounts, volumes, resource limits, basic-auth users and crons. Nothing is
-- deployed: the source instance keeps serving those hostnames, and two ACME
-- clients on one name fight.
--
-- These two tables exist for the half of a migration that is NOT "it worked":
-- the private repo that came across with no credential, the database whose host
-- name changed so every connection string needs a look, the published port deplo
-- does not do, the compose file whose `dokploy-network` had to be stripped. That
-- list is the report, and a report that lives only in the wizard's last step is
-- one nobody can consult on the day an app turns out to be missing a mount.
--
-- `dokploy_imports` is one row per run, written `running` before the first
-- object is created, so an interrupted import lands as a failed run rather than
-- vanishing. Shaped like `docker_cleanup_runs` for the same reason: same kind of
-- object. `seq bigint identity` breaks same-millisecond ties so
-- `ORDER BY started_at DESC, seq DESC` is a total order.
--
-- The API key is NOT here and must never be: it is passed per call and lives in
-- the wizard's component state. Storing it would leave a credential for someone
-- else's platform sitting in deplo's database with no rotation story and nothing
-- that needs it after the import.
--
-- `dokploy_import_items` is a LIST under a run, so a child table (never a JSONB
-- column, per the persistence rule). `outcome` is four plain-text values -
-- created / skipped / failed / manual - with no CHECK, like `backup_runs.status`:
-- the data layer is the boundary, and a CHECK here would only be a second place
-- for the set to drift. `path` is the readable breadcrumb
-- ("Blink / production / blink-web") so the report still reads correctly once the
-- source instance is gone; `target_id` deliberately carries no FK for the same
-- reason - deleting an imported app must not rewrite the history that mentions it.
--
-- Both tables are NEW: nothing to backfill, no NOT NULL added to a populated
-- table (the migrator auto-applies at boot against live self-hosted databases).
CREATE TABLE "dokploy_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "dokploy_imports_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"team_id" text NOT NULL,
	"source_url" text NOT NULL,
	"org_name" text,
	"actor" text NOT NULL,
	"status" text NOT NULL,
	"created" integer NOT NULL,
	"skipped" integer NOT NULL,
	"failed" integer NOT NULL,
	"manual" integer NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dokploy_import_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "dokploy_import_items_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"path" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_name" text NOT NULL,
	"outcome" text NOT NULL,
	"target_kind" text,
	"target_id" text,
	"message" text
);
--> statement-breakpoint
ALTER TABLE "dokploy_imports" ADD CONSTRAINT "dokploy_imports_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dokploy_import_items" ADD CONSTRAINT "dokploy_import_items_run_id_dokploy_imports_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."dokploy_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dokploy_imports_team_started_idx" ON "dokploy_imports" USING btree ("team_id","started_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dokploy_import_items_run_idx" ON "dokploy_import_items" USING btree ("run_id","seq");
