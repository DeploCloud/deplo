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
    service: text("service"),
    schedule: text("schedule").notNull(),
    // Validated on write: Intl throws on an unknown zone, which would take down the whole scheduler tick.
    timezone: text("timezone").notNull().default("UTC"),
    shell: text("shell").notNull().default("sh"),
    command: text("command").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    timeoutSeconds: integer("timeout_seconds").notNull().default(3600),
    maxAttempts: integer("max_attempts").notNull().default(1),
    overlap: text("overlap").notNull().default("skip"),
    keepRuns: integer("keep_runs").notNull().default(50),
    workdir: text("workdir"),
    user: text("user"),
    lastRunAt: isoTimestamptz("last_run_at"),
    lastStatus: text("last_status"),
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
    index("cron_jobs_enabled_idx")
      .on(t.enabled)
      .where(sql`${t.enabled}`),
    index("cron_jobs_team_idx").on(t.teamId),
  ],
);

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
    trigger: text("trigger").notNull().default("schedule"),
    actor: text("actor").notNull().default("Scheduler"),
    scheduledFor: isoTimestamptz("scheduled_for").notNull(),
    // Wall-clock key for an hour-pinned schedule, instant key otherwise: the two halves of DST need opposite keys.
    dedupeKey: text("dedupe_key").notNull(),
    startedAt: isoTimestamptz("started_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: isoTimestamptz("next_attempt_at"),
    agentJobId: text("agent_job_id"),
    exitCode: integer("exit_code"),
    stdout: text("stdout"),
    stderr: text("stderr"),
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
