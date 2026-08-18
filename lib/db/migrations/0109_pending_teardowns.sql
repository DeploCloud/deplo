-- A teardown that failed is an INTENT, not a warning.
--
-- Deleting an app tore its stack down best-effort and dropped the control-plane
-- row regardless: an unreachable host kept the containers AND the volumes, and
-- the only trace was an Activity line telling somebody to go remove them by
-- hand. Nothing retried (`resumeAppDeletes` re-drove the same `destroyApp`,
-- which deletes the row whether or not the teardown worked, so the boot retry
-- could never fire twice), nothing kept count, and for a preview of a deleted
-- app or a deleted team's stacks not even a row was left that could NAME what
-- is still running on that host.
--
-- One row per stack that must die, written BEFORE the agent is dialed.
-- Write-ahead rather than on-failure because a control plane killed mid-teardown
-- does not get to run a catch block, and because a team delete drops its rows
-- before the fan-out even starts. The happy path costs one INSERT and one
-- DELETE.
--
-- `project_label` is the `deplo.project` label value (an App id, a preview's own
-- id, a database id) and it is what makes a retry SAFE: `apps_slug_uq` is
-- global, so a deleted slug can be taken by a new app on the same server, and a
-- retry keyed on the deploy key alone would `compose down -v` somebody's live
-- app and report success. The drain asks the host what still carries the DOOMED
-- id, so a reclaimed key answers "nothing of ours" and the row is dropped
-- without a destructive call.
--
-- `server_id` CASCADEs: removing a host from the fleet is the escape valve, and
-- its queued teardowns go with it (the removal says how many). `team_id` is SET
-- NULL because the team-delete case outlives its own team, and a teardown with
-- no team has no honest Activity feed to land in, so it stays quiet there and
-- speaks through the server alert instead.
--
-- UNIQUE (server_id, deploy_key) is the dedupe: a second enqueue for the same
-- stack must be a no-op, not a second ladder of retries. No other index: on a
-- healthy instance this table is EMPTY.
--
-- No `kind` column (the teardown is the same RPC for an app, a preview and a
-- database) and no `remove_volumes` (every case that lands here takes its
-- volumes with it).

CREATE TABLE IF NOT EXISTS "pending_teardowns" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"deploy_key" text NOT NULL,
	"project_label" text NOT NULL,
	"label" text NOT NULL,
	"team_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"next_attempt_at" timestamptz NOT NULL,
	"abandoned_at" timestamptz,
	"created_at" timestamptz NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_teardowns" ADD CONSTRAINT "pending_teardowns_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_teardowns" ADD CONSTRAINT "pending_teardowns_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pending_teardowns_server_key_uq" ON "pending_teardowns" USING btree ("server_id","deploy_key");
