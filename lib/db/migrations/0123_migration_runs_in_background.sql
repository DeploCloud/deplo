-- The import loop moves out of the browser tab and into the control plane.
--
-- It lived in the tab because it held the Dokploy API key, which was never
-- stored - and that one property cost everything else. A reload killed the run
-- mid-flight, leaving projects created here, services stopped over there and a
-- row that said `running` with nobody running it. Coming back showed the
-- organisation's name where the progress should be, because the plan that knew
-- the progress had died with the tab. Closing the laptop was a data-loss event.
--
-- So the key is stored, encrypted like every other secret Deplo holds, and wiped
-- the moment the run leaves `running`. That is a deliberate reversal of "the API
-- key is never stored", made because the alternative is a migration that cannot
-- survive a page reload.
ALTER TABLE "dokploy_imports"
  ADD COLUMN IF NOT EXISTS "api_key_enc" text,
  ADD COLUMN IF NOT EXISTS "allow_private" boolean DEFAULT false NOT NULL,
  -- Progress the SERVER owns, so every viewer sees the same numbers and a reload
  -- shows what a reload should: where the run actually is.
  ADD COLUMN IF NOT EXISTS "total_steps" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "done_steps" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "step_label" text,
  -- 'config' | 'data' | 'done'.
  ADD COLUMN IF NOT EXISTS "phase" text DEFAULT 'config' NOT NULL,
  -- Stop is a REQUEST now, not a return from a loop: the thing that stops is on
  -- another machine, and it checks between steps.
  ADD COLUMN IF NOT EXISTS "stop_requested" boolean DEFAULT false NOT NULL,
  -- Liveness of whichever process is driving it. A run whose heartbeat goes cold
  -- is one whose control plane died; the next tick picks it up where it stopped.
  ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "runner_owner" text,
  -- WHO started it, as an id rather than the display name `actor` already holds.
  -- The runner re-enters every normal gate under this identity through
  -- `runWithIdentity`, the same way the deploy hook and the MCP server do: a
  -- background job must not get a hand-rolled capability check of its own.
  ADD COLUMN IF NOT EXISTS "actor_user_id" text;--> statement-breakpoint
-- What the person chose, so the runner can carry it out without them. One row
-- per SERVICE, because that is the grain the loop works at and the grain a
-- resume has to be honest about: a run that comes back after a restart must know
-- which services are already through.
CREATE TABLE IF NOT EXISTS "dokploy_run_targets" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL REFERENCES "dokploy_imports"("id") ON DELETE CASCADE,
  "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "project_id" text NOT NULL,
  "project_name" text NOT NULL,
  "service_id" text NOT NULL,
  "server_id" text,
  "build_server_id" text,
  -- A database's host port is TRI-state and one nullable column cannot say it:
  -- absent keeps the source's own port, null publishes nothing, a number
  -- publishes there. So the flag says whether the column is an instruction at
  -- all. Collapsing the three was how an import quietly republished a port
  -- somebody had chosen to close.
  "exposed_port" integer,
  "exposed_port_set" boolean DEFAULT false NOT NULL,
  -- 'pending' | 'done' | 'failed', for the config half. The data half reads the
  -- run's own items, which already record what landed.
  "state" text DEFAULT 'pending' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dokploy_run_targets_run_idx"
  ON "dokploy_run_targets" ("run_id","seq");--> statement-breakpoint
-- Which Deplo server each Dokploy machine's services land on. The fallback the
-- per-service placement does not cover.
CREATE TABLE IF NOT EXISTS "dokploy_run_servers" (
  "run_id" text NOT NULL REFERENCES "dokploy_imports"("id") ON DELETE CASCADE,
  "from_id" text NOT NULL,
  "to_id" text NOT NULL,
  CONSTRAINT "dokploy_run_servers_pkey" PRIMARY KEY ("run_id","from_id")
);--> statement-breakpoint
-- When each line of the report happened. A report read after the fact is a list;--> statement-breakpoint
-- a report read WHILE it runs is a log, and a log without times is not one.
ALTER TABLE "dokploy_import_items"
  ADD COLUMN IF NOT EXISTS "at" timestamp with time zone;
