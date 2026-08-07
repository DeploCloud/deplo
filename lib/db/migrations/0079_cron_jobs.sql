-- Cron jobs: a command run inside one container of an App or a Database, on a
-- schedule, in that job's own timezone.
--
-- OFF by default on both target kinds. A cron job runs arbitrary commands as the
-- container's user with no sandbox, so it is opted into per target rather than
-- appearing on every app that already exists. The switch is also the pause
-- button: turning it off stops the schedule and keeps the jobs.
ALTER TABLE "apps" ADD COLUMN "cron_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "cron_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- One row per scheduled command.
--
-- Shaped like `backups` (team-scoped, XOR target, schedule + enabled) with three
-- deliberate differences:
--
--   `timezone` is per job. Backups and the docker-cleanup policy are UTC-only
--   and get away with it because "some time overnight" is the whole requirement.
--   A cron job is somebody's business rule: the nightly invoice run happens at
--   02:00 in the company's timezone, and it still does after a DST shift.
--
--   `service` holds a COMPOSE SERVICE, never a container name. A stack's
--   container names are generated (deplo-<slug>-<service>-N) and a redeploy can
--   mint new ones, so the container is resolved live before every attempt.
--   NULL means the target's primary container — the only possibility for a
--   database, which is a single-container stack.
--
--   `timeout_seconds` is per ATTEMPT: it is the agent's `docker exec` deadline,
--   and the agent knows nothing about the retry ladder. The data layer clamps
--   timeout x max_attempts to 24h so a retrying run cannot hold the `running`
--   slot for days and starve every later fire under overlap = 'skip'.
CREATE TABLE "cron_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"app_id" text,
	"database_id" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"service" text,
	"schedule" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"shell" text DEFAULT 'sh' NOT NULL,
	"command" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeout_seconds" integer DEFAULT 3600 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"overlap" text DEFAULT 'skip' NOT NULL,
	"keep_runs" integer DEFAULT 50 NOT NULL,
	"workdir" text,
	"user" text,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_success_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cron_jobs_target_kind_xor" CHECK (("cron_jobs"."target_kind" = 'app' and "cron_jobs"."app_id" is not null and "cron_jobs"."database_id" is null)
          or ("cron_jobs"."target_kind" = 'database' and "cron_jobs"."database_id" is not null and "cron_jobs"."app_id" is null))
);
--> statement-breakpoint
-- Extra environment for one job, on top of what the container already has.
-- A child table and not a column because `value_enc` is a real secret: AES-GCM
-- ciphertext that never enters a DTO and reaches the host inside the mTLS RPC
-- with the NAME on argv and the VALUE in the docker client's own environment, so
-- it is never readable from `ps` on the box.
CREATE TABLE "cron_job_env" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"key" text NOT NULL,
	"value_enc" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- One row per scheduled fire, retries included.
--
-- Six statuses: running | succeeded | failed | timedout | skipped | lost.
-- `lost` is the one a backup run cannot have and this one must: the command runs
-- inside the AGENT's process, so restarting the control plane does not kill it —
-- we come back and poll for the real exit code. Only an agent restart genuinely
-- loses a run, and calling that `failed` would fire a failure alert for something
-- that most likely succeeded.
--
-- A retry never writes a terminal status: it leaves the row `running` with
-- `agent_job_id` NULL and `next_attempt_at` set. Invariant: a `running` row has
-- exactly one of those two non-null.
--
-- `command` / `container` / `timeout_seconds` / `max_attempts` are FROZEN at
-- insert. Editing a job mid-flight must not change the deadline the reaper
-- enforces, and the history must say what actually ran, not what the job says
-- today.
CREATE TABLE "cron_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "cron_runs_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"team_id" text NOT NULL,
	"job_id" text NOT NULL,
	"status" text NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"actor" text DEFAULT 'Scheduler' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"dedupe_key" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"agent_job_id" text,
	"exit_code" integer,
	"stdout" text,
	"stderr" text,
	"error" text,
	"command" text NOT NULL,
	"container" text DEFAULT '' NOT NULL,
	"timeout_seconds" integer NOT NULL,
	"max_attempts" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cron_job_env" ADD CONSTRAINT "cron_job_env_job_id_cron_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."cron_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- CASCADE, unlike backup_runs.backup_id which is SET NULL: a backup run points at
-- an artifact that outlives its schedule, a cron run describes only itself. When
-- the job is gone there is nothing left for its history to be about.
ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_job_id_cron_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."cron_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "cron_jobs_app_name_uq" ON "cron_jobs" ("app_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "cron_jobs_database_name_uq" ON "cron_jobs" ("database_id","name");
--> statement-breakpoint
-- Partial: the tick reads the enabled jobs and nothing else, once a minute
-- forever, so the index should hold only the working set.
CREATE INDEX "cron_jobs_enabled_idx" ON "cron_jobs" ("enabled") WHERE "enabled";
--> statement-breakpoint
CREATE INDEX "cron_jobs_team_idx" ON "cron_jobs" ("team_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "cron_job_env_job_key_uq" ON "cron_job_env" ("job_id","key");
--> statement-breakpoint
-- THE double-fire guard, and the reason the cron scheduler needs no in-RAM
-- `lastFired` map like the backup one keeps. It survives a control-plane restart,
-- two instances racing for the lease, and a backwards clock step. The INSERT is
-- also the serialization point, which is why overlap is decided AFTER it: two
-- instances can never both conclude "nothing else is running".
CREATE UNIQUE INDEX "cron_runs_dedupe_uq" ON "cron_runs" ("job_id","dedupe_key");
--> statement-breakpoint
-- The reaper's only scan, partial so it indexes just the in-flight runs.
CREATE INDEX "cron_runs_running_idx" ON "cron_runs" ("status") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX "cron_runs_job_seq_idx" ON "cron_runs" ("job_id","seq" DESC);
