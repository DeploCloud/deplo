-- The wizard's queue of teams moved out of the browser tab: several teams of one
-- panel are several runs of one session, and the control plane walks them.
ALTER TABLE "migration_runs" ADD COLUMN "session_id" text;
--> statement-breakpoint

CREATE INDEX "migration_runs_session_idx" ON "migration_runs" ("session_id", "seq");
--> statement-breakpoint

-- Every run is its own session until one says otherwise, so a run that predates
-- the queue still answers "which runs belong with this one".
UPDATE "migration_runs" SET "session_id" = "id" WHERE "session_id" IS NULL;
--> statement-breakpoint

-- Who the panel listed on the team a run brought over, recorded by the run so the
-- People step survives the tab and the wiping of the panel's token.
CREATE TABLE "migration_run_members" (
  "id" text PRIMARY KEY,
  "run_id" text NOT NULL REFERENCES "migration_runs"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "name" text NOT NULL,
  "source_role" text NOT NULL DEFAULT '',
  "outcome" text NOT NULL,
  "message" text,
  "link_id" text,
  "created_at" timestamptz NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX "migration_run_members_run_email_uq"
  ON "migration_run_members" ("run_id", "email");
