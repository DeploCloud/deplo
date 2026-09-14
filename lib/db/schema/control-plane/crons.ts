import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { databases } from "./databases";
import { teams, users } from "./identity";

// cronJobs - [CronJob](../../../types.ts), a command run inside one container on a cron schedule.
export const cronJobs = pgTable(
  "cron_jobs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").notNull(),
    appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),
    databaseId: text("database_id").references(() => databases.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // Compose service to exec into. NULL ⇒ the target's primary container.
    service: text("service"),
    // 5-field cron, evaluated in `timezone` (NOT in UTC).
    schedule: text("schedule").notNull(),
    // IANA zone, validated on write - `Intl` throws on an unknown one, and an
    // unvalidated value would take down the whole scheduler tick.
    timezone: text("timezone").notNull().default("UTC"),
    // "sh" | "bash". A named shell the image lacks fails the run rather than
    // silently substituting the other: `set -o pipefail` and `[[` change
    // meaning between them.
    shell: text("shell").notNull().default("sh"),
    command: text("command").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // Per ATTEMPT, not per run: it is the agent's `docker exec` deadline, and the
    // agent knows nothing about the retry ladder.
    timeoutSeconds: integer("timeout_seconds").notNull().default(3600),
    // Total launches per scheduled fire: 1 = no retry, up to 4.
    maxAttempts: integer("max_attempts").notNull().default(1),
    // "skip" | "allow" - what to do when the previous run is still going.
    overlap: text("overlap").notNull().default("skip"),
    // Runs kept in the history for this job; older ones are pruned on settle.
    keepRuns: integer("keep_runs").notNull().default(50),
    workdir: text("workdir"),
    user: text("user"),
    lastRunAt: isoTimestamptz("last_run_at"),
    lastStatus: text("last_status"),
    // Surfaced on the job row so a job that has been silently `skipped` for a
    // week (its container is stopped) is visible without adding an alert key.
    lastSuccessAt: isoTimestamptz("last_success_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    check(
      "cron_jobs_target_kind_xor",
      sql`(${t.targetKind} = 'app' and ${t.appId} is not null and ${t.databaseId} is null)
          or (${t.targetKind} = 'database' and ${t.databaseId} is not null and ${t.appId} is null)`,
    ),
    uniqueIndex("cron_jobs_app_name_uq").on(t.appId, t.name),
    uniqueIndex("cron_jobs_database_name_uq").on(t.databaseId, t.name),
    // The scheduler's scan: every tick reads the enabled jobs and nothing else.
    index("cron_jobs_enabled_idx")
      .on(t.enabled)
      .where(sql`${t.enabled}`),
    index("cron_jobs_team_idx").on(t.teamId),
  ],
);

// cronJobEnv - extra environment for one cron job, on top of what the container already has.
export const cronJobEnv = pgTable(
  "cron_job_env",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => cronJobs.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("cron_job_env_job_key_uq").on(t.jobId, t.key)],
);

// cronRuns - [CronRun](../../../types.ts), one scheduled fire of a job, retries included.
export const cronRuns = pgTable(
  "cron_runs",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => cronJobs.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    // "schedule" | "manual" - a hand-pressed Run now is not a missed schedule.
    trigger: text("trigger").notNull().default("schedule"),
    actor: text("actor").notNull().default("Scheduler"),
    // The cron minute this run answers, as a UTC instant.
    scheduledFor: isoTimestamptz("scheduled_for").notNull(),
    // Wall-clock key for an hour-pinned schedule, instant key otherwise - see
    // lib/crons/cron-tz.ts. The two halves of the DST problem need opposite
    // keys, and picking one for both breaks the other.
    dedupeKey: text("dedupe_key").notNull(),
    startedAt: isoTimestamptz("started_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
    // 0-based launch count for THIS fire. Output is always the last attempt's.
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: isoTimestamptz("next_attempt_at"),
    // The agent's handle. Valid for that agent PROCESS only; a poll answering
    // "not found" is how we learn the agent restarted under us.
    agentJobId: text("agent_job_id"),
    exitCode: integer("exit_code"),
    stdout: text("stdout"),
    stderr: text("stderr"),
    // Why it failed, or why it was skipped. Not command output.
    error: text("error"),
    command: text("command").notNull(),
    container: text("container").notNull().default(""),
    timeoutSeconds: integer("timeout_seconds").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
  },
  (t) => [
    uniqueIndex("cron_runs_dedupe_uq").on(t.jobId, t.dedupeKey),
    index("cron_runs_running_idx")
      .on(t.status)
      .where(sql`${t.status} = 'running'`),
    index("cron_runs_job_seq_idx").on(t.jobId, t.seq.desc()),
  ],
);
