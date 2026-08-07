import "server-only";

import { cache } from "react";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";

import { getCurrentUser } from "../auth";
import { getDb } from "../db/client";
import {
  cronJobEnv as cronJobEnvTable,
  cronJobs as cronJobsTable,
  cronRuns as cronRunsTable,
  apps as appsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import { encryptSecret } from "../crypto";
import { composeServiceNames } from "../deploy/compose-stack";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { invalidScheduleMessage, isValidSchedule } from "../schedule";
import { canonicalTimeZone, dstSkipWarning, nextCronRunInZone } from "../crons/cron-tz";
import {
  cancelRun,
  loadInFlightRun,
  loadSchedulableJob,
  runJobNow,
} from "../crons/runner";
import type {
  CronOverlap,
  CronRunStatus,
  CronShell,
  CronTargetKind,
} from "../types";
import { recordActivity } from "./activity";
import { loadAppGraph } from "./app-graph-load";
import { requireFolderCapabilityForApp } from "./folder-access";
import { requireAppCapability } from "./node-access";

/**
 * The gated surface for **cron jobs** - the security boundary the UI and GraphQL
 * go through.
 *
 * The mechanics live one layer down in [runner](../crons/runner.ts), which is
 * deliberately session-free so the scheduler can call it at 03:00 with no request
 * identity. Everything here does the capability + team + folder work FIRST and
 * only then delegates, exactly like the preview mutations do.
 *
 * TWO GATES ON A DATABASE JOB, and the second is not belt-and-braces. One
 * `manage_crons` governs both target kinds (a person who schedules commands
 * schedules commands), and it is seeded from EITHER console capability - so
 * without the extra `open_database_console` check here, holding app-console
 * access alone would reach inside every database on the instance. See ADR-0018.
 */

/** Longest a single attempt may run. Anything longer is a service, not a job. */
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
/** The ceiling on `timeout x attempts`: a retrying run holds the job's `running`
 *  slot, and under overlap=skip a multi-day one starves every later fire. */
const MAX_TOTAL_SECONDS = 24 * 60 * 60;
const MIN_KEEP_RUNS = 10;
const MAX_KEEP_RUNS = 500;
const MAX_ATTEMPTS = 4;
const MAX_ENV_VARS = 50;

export interface CronJobDTO {
  id: string;
  targetKind: CronTargetKind;
  appId: string | null;
  databaseId: string | null;
  name: string;
  description: string;
  service: string | null;
  schedule: string;
  timezone: string;
  shell: CronShell;
  command: string;
  enabled: boolean;
  timeoutSeconds: number;
  maxAttempts: number;
  overlap: CronOverlap;
  keepRuns: number;
  workdir: string | null;
  user: string | null;
  lastRunAt: string | null;
  lastStatus: CronRunStatus | null;
  lastSuccessAt: string | null;
  /** Computed, never stored: the next instant this fires, in the job's zone. */
  nextRunAt: string | null;
  /** The keys of the job's extra environment. NEVER the values (ADR: secrets are
   *  write-only and have no reveal path). */
  envKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CronRunDTO {
  id: string;
  jobId: string;
  status: CronRunStatus;
  trigger: string;
  actor: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  attempt: number;
  maxAttempts: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  container: string;
  command: string;
  /** True while a retry waits out its backoff, which reads very differently from
   *  "the command is running" even though both are `running` rows. */
  retrying: boolean;
}

/** Everything a Cron jobs page renders in one read. */
export interface CronJobsView {
  targetKind: CronTargetKind;
  targetId: string;
  /** The per-target master switch. While false the scheduler skips every job. */
  enabled: boolean;
  jobs: CronJobDTO[];
  /** Compose services that can be picked as a job's container. Empty for a
   *  database (one container) and when the host cannot be reached. */
  services: string[];
}

type JobRow = typeof cronJobsTable.$inferSelect;

function toJobDTO(r: JobRow, envKeys: string[]): CronJobDTO {
  return {
    id: r.id,
    targetKind: r.targetKind as CronTargetKind,
    appId: r.appId,
    databaseId: r.databaseId,
    name: r.name,
    description: r.description,
    service: r.service,
    schedule: r.schedule,
    timezone: r.timezone,
    shell: r.shell as CronShell,
    command: r.command,
    enabled: r.enabled,
    timeoutSeconds: r.timeoutSeconds,
    maxAttempts: r.maxAttempts,
    overlap: r.overlap as CronOverlap,
    keepRuns: r.keepRuns,
    workdir: r.workdir,
    user: r.user,
    lastRunAt: r.lastRunAt,
    lastStatus: (r.lastStatus as CronRunStatus | null) ?? null,
    lastSuccessAt: r.lastSuccessAt,
    nextRunAt: r.enabled
      ? (nextCronRunInZone(r.schedule, new Date(), r.timezone)?.toISOString() ?? null)
      : null,
    envKeys,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toRunDTO(r: typeof cronRunsTable.$inferSelect): CronRunDTO {
  return {
    id: r.id,
    jobId: r.jobId,
    status: r.status as CronRunStatus,
    trigger: r.trigger,
    actor: r.actor,
    scheduledFor: r.scheduledFor,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    exitCode: r.exitCode,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
    container: r.container,
    command: r.command,
    retrying: r.status === "running" && r.agentJobId === null,
  };
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

/**
 * The gate for an APP's cron jobs: team, folder and per-node grants together,
 * which all answer "App not found" so the check is never an oracle for which ids
 * exist.
 */
async function gateApp(appId: string) {
  await requireAppCapability(appId, "manage_crons");
  await requireFolderCapabilityForApp(appId, "manage_crons");
  const teamId = await requireActiveTeamId();
  const app = await loadAppGraph(appId);
  if (!app || app.teamId !== teamId) throw new Error("App not found");
  return { app, teamId };
}

/**
 * The gate for a DATABASE's cron jobs. Both capabilities, for the reason in this
 * module's header: `manage_crons` alone is seeded from app-console access too.
 */
async function gateDatabase(databaseId: string) {
  const { teamId } = await requireCapability("manage_crons");
  await requireCapability("open_database_console");
  const rows = await getDb()
    .select({ id: databasesTable.id, cronEnabled: databasesTable.cronEnabled })
    .from(databasesTable)
    .where(and(eq(databasesTable.id, databaseId), eq(databasesTable.teamId, teamId)))
    .limit(1);
  if (rows.length === 0) throw new Error("Database not found");
  return { teamId, database: rows[0] };
}

/**
 * The gate for an existing job, resolved through whichever target it hangs off.
 * Also reports the TARGET's master switch, which several callers need - running
 * a job by hand on a target where cron jobs are switched off would drive a hole
 * straight through the opt-in.
 */
async function gateJob(
  jobId: string,
): Promise<{ job: JobRow; teamId: string; targetEnabled: boolean }> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(cronJobsTable)
    .where(and(eq(cronJobsTable.id, jobId), eq(cronJobsTable.teamId, teamId)))
    .limit(1);
  const job = rows[0];
  if (!job) throw new Error("Cron job not found");
  if (job.appId) {
    const { app } = await gateApp(job.appId);
    return { job, teamId, targetEnabled: app.cronEnabled };
  }
  if (job.databaseId) {
    const { database } = await gateDatabase(job.databaseId);
    return { job, teamId, targetEnabled: database.cronEnabled };
  }
  throw new Error("Cron job not found");
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface CronJobInput {
  name?: string;
  description?: string | null;
  service?: string | null;
  schedule?: string;
  timezone?: string;
  shell?: string;
  command?: string;
  enabled?: boolean;
  timeoutSeconds?: number;
  maxAttempts?: number;
  overlap?: string;
  keepRuns?: number;
  workdir?: string | null;
  user?: string | null;
  /** Replaces the job's extra environment wholesale when present. */
  env?: { key: string; value: string }[];
}

/** The validated patch, or a thrown error carrying the sentence the UI shows. */
function buildPatch(
  input: CronJobInput,
  current?: JobRow,
): Partial<typeof cronJobsTable.$inferInsert> {
  const patch: Partial<typeof cronJobsTable.$inferInsert> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("Give the cron job a name");
    if (name.length > 80) throw new Error("Keep the name to 80 characters or fewer");
    patch.name = name;
  }
  if (input.description !== undefined) {
    patch.description = (input.description ?? "").trim().slice(0, 500);
  }
  if (input.service !== undefined) {
    patch.service = (input.service ?? "").trim() || null;
  }
  if (input.schedule !== undefined) {
    const schedule = input.schedule.trim().replace(/\s+/g, " ");
    // An invalid expression is accepted nowhere: the scheduler treats an
    // unparseable cron as "never matches", so storing one would leave a job the
    // UI calls enabled and that silently never runs.
    if (!isValidSchedule(schedule)) throw new Error(invalidScheduleMessage(schedule));
    patch.schedule = schedule;
  }
  if (input.timezone !== undefined) {
    const tz = canonicalTimeZone(input.timezone);
    if (!tz) {
      throw new Error(
        `"${input.timezone.trim()}" is not a timezone. Pick one from the list, like "Europe/Rome".`,
      );
    }
    patch.timezone = tz;
  }
  if (input.shell !== undefined) {
    if (input.shell !== "sh" && input.shell !== "bash") {
      throw new Error("The shell must be sh or bash");
    }
    patch.shell = input.shell;
  }
  if (input.command !== undefined) {
    const command = input.command.trim();
    if (!command) throw new Error("Give the cron job a command to run");
    if (command.length > 8000) {
      throw new Error("Keep the command under 8000 characters - put a long script in the image");
    }
    patch.command = command;
  }
  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
  if (input.overlap !== undefined) {
    if (input.overlap !== "skip" && input.overlap !== "allow") {
      throw new Error("Overlap must be skip or allow");
    }
    patch.overlap = input.overlap;
  }
  if (input.keepRuns !== undefined) {
    if (input.keepRuns < MIN_KEEP_RUNS || input.keepRuns > MAX_KEEP_RUNS) {
      throw new Error(`Keep between ${MIN_KEEP_RUNS} and ${MAX_KEEP_RUNS} runs of history`);
    }
    patch.keepRuns = Math.trunc(input.keepRuns);
  }
  if (input.workdir !== undefined) patch.workdir = (input.workdir ?? "").trim() || null;
  if (input.user !== undefined) patch.user = (input.user ?? "").trim() || null;

  if (input.timeoutSeconds !== undefined) {
    if (input.timeoutSeconds < 1 || input.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw new Error("Keep the timeout between 1 second and 24 hours");
    }
    patch.timeoutSeconds = Math.trunc(input.timeoutSeconds);
  }
  if (input.maxAttempts !== undefined) {
    if (input.maxAttempts < 1 || input.maxAttempts > MAX_ATTEMPTS) {
      throw new Error(`Allow between 1 and ${MAX_ATTEMPTS} attempts`);
    }
    patch.maxAttempts = Math.trunc(input.maxAttempts);
  }

  // The clamp that keeps a retrying run from holding the job's `running` slot for
  // days: the timeout is PER ATTEMPT, so the honest worst case is their product.
  const timeout = patch.timeoutSeconds ?? current?.timeoutSeconds ?? 3600;
  const attempts = patch.maxAttempts ?? current?.maxAttempts ?? 1;
  if (timeout * attempts > MAX_TOTAL_SECONDS) {
    throw new Error(
      `${attempts} attempts of ${Math.round(timeout / 60)} minutes could run for ` +
        `${Math.round((timeout * attempts) / 3600)} hours. Lower the timeout or the retries so they fit in 24 hours.`,
    );
  }
  return patch;
}

function validateEnv(env: { key: string; value: string }[]): {
  key: string;
  value: string;
}[] {
  if (env.length > MAX_ENV_VARS) {
    throw new Error(`Keep the job to ${MAX_ENV_VARS} variables or fewer`);
  }
  const seen = new Set<string>();
  const out: { key: string; value: string }[] = [];
  for (const e of env) {
    const key = e.key.trim();
    if (!key) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`"${key}" is not a valid variable name - use letters, digits and underscores`);
    }
    if (seen.has(key)) throw new Error(`"${key}" is listed twice`);
    seen.add(key);
    out.push({ key, value: e.value });
  }
  return out;
}

/** Replace a job's extra environment. Values are encrypted and never read back. */
async function writeEnv(jobId: string, env: { key: string; value: string }[]): Promise<void> {
  await getDb().delete(cronJobEnvTable).where(eq(cronJobEnvTable.jobId, jobId));
  if (env.length === 0) return;
  await getDb()
    .insert(cronJobEnvTable)
    .values(
      env.map((e) => ({
        id: newId("cronenv"),
        jobId,
        key: e.key,
        valueEnc: encryptSecret(e.value),
        createdAt: nowIso(),
      })),
    );
}

/** The NAMES of each job's extra variables. Never `value_enc` - a secret has no
 *  reveal path, and these DTOs are handed straight to the client. */
async function envKeysFor(jobIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (jobIds.length === 0) return out;
  const rows = await getDb()
    .select({ jobId: cronJobEnvTable.jobId, key: cronJobEnvTable.key })
    .from(cronJobEnvTable)
    .where(inArray(cronJobEnvTable.jobId, jobIds))
    .orderBy(cronJobEnvTable.key);
  for (const r of rows) {
    const list = out.get(r.jobId);
    if (list) list.push(r.key);
    else out.set(r.jobId, [r.key]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

async function jobsFor(where: SQL): Promise<CronJobDTO[]> {
  const rows = await getDb()
    .select()
    .from(cronJobsTable)
    .where(where)
    .orderBy(cronJobsTable.name);
  const keys = await envKeysFor(rows.map((r) => r.id));
  return rows.map((r) => toJobDTO(r, keys.get(r.id) ?? []));
}

/** An app's cron jobs, plus the switch and the services a job can target. */
export const listAppCronJobs = cache(async (appId: string): Promise<CronJobsView> => {
  const { app } = await gateApp(appId);
  return {
    targetKind: "app",
    targetId: appId,
    enabled: app.cronEnabled,
    jobs: await jobsFor(eq(cronJobsTable.appId, appId)),
    services: appServices(app.compose, app.slug),
  };
});

/**
 * The compose services a job may pick, read from the app's own stack DOCUMENT
 * rather than from the live host. A stopped app must still be configurable, and
 * asking the agent here would make the page fail whenever the server is down.
 */
function appServices(compose: string | null, slug: string): string[] {
  if (!compose) return [slug];
  const names = composeServiceNames(compose);
  return names.length > 0 ? names : [slug];
}

/** A database's cron jobs. One container, so no service list. */
export const listDatabaseCronJobs = cache(
  async (databaseId: string): Promise<CronJobsView> => {
    const { database } = await gateDatabase(databaseId);
    return {
      targetKind: "database",
      targetId: databaseId,
      enabled: database.cronEnabled,
      jobs: await jobsFor(eq(cronJobsTable.databaseId, databaseId)),
      services: [],
    };
  },
);

/**
 * One job's run history, newest first.
 *
 * Gated on `manage_crons` and NOT on `view`, because stdout can contain anything
 * the command printed - including whatever was in the job's environment.
 */
export async function listCronRuns(jobId: string, limit = 50): Promise<CronRunDTO[]> {
  await gateJob(jobId);
  const rows = await getDb()
    .select()
    .from(cronRunsTable)
    .where(eq(cronRunsTable.jobId, jobId))
    .orderBy(desc(cronRunsTable.seq))
    .limit(Math.min(Math.max(limit, 1), MAX_KEEP_RUNS));
  return rows.map(toRunDTO);
}

/** The sentence to show under a schedule DST could skip, or null. */
export function cronDstWarning(schedule: string, timezone: string): string | null {
  return dstSkipWarning(schedule, timezone);
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

/**
 * Turn cron jobs on or off for one target. The switch is the opt-in AND the pause
 * button: turning it off stops the schedule and keeps every job.
 *
 * Runs already in flight are deliberately left alone - the command is executing
 * on the host, and killing it halfway is a worse surprise than letting it finish.
 */
export async function setCronEnabled(
  targetKind: CronTargetKind,
  targetId: string,
  enabled: boolean,
): Promise<void> {
  const user = await getCurrentUser();
  const actor = user?.name ?? "Deplo";
  if (targetKind === "app") {
    const { app, teamId } = await gateApp(targetId);
    const rows = await getDb()
      .update(appsTable)
      .set({ cronEnabled: enabled, updatedAt: nowIso() })
      .where(and(eq(appsTable.id, targetId), eq(appsTable.teamId, teamId)))
      .returning({ id: appsTable.id });
    if (rows.length === 0) throw new Error("App not found");
    await recordActivity(
      "cron",
      `${enabled ? "Enabled" : "Disabled"} cron jobs for ${app.name}`,
      actor,
      targetId,
    );
    return;
  }
  const { teamId } = await gateDatabase(targetId);
  const rows = await getDb()
    .update(databasesTable)
    .set({ cronEnabled: enabled })
    .where(and(eq(databasesTable.id, targetId), eq(databasesTable.teamId, teamId)))
    .returning({ name: databasesTable.name });
  if (rows.length === 0) throw new Error("Database not found");
  await recordActivity(
    "cron",
    `${enabled ? "Enabled" : "Disabled"} cron jobs for database ${rows[0].name}`,
    actor,
    null,
    teamId,
  );
}

export async function createCronJob(
  targetKind: CronTargetKind,
  targetId: string,
  input: CronJobInput,
): Promise<CronJobDTO> {
  const user = await getCurrentUser();
  const teamId =
    targetKind === "app"
      ? (await gateApp(targetId)).teamId
      : (await gateDatabase(targetId)).teamId;

  // Required on create, optional on edit - so the patch builder is shared and the
  // requiredness lives in exactly one place.
  if (input.name === undefined) throw new Error("Give the cron job a name");
  if (input.command === undefined) throw new Error("Give the cron job a command to run");
  if (input.schedule === undefined) throw new Error("Give the cron job a schedule");

  const patch = buildPatch(input);
  const env = input.env ? validateEnv(input.env) : [];
  const now = nowIso();
  const id = newId("cron");

  try {
    await getDb()
      .insert(cronJobsTable)
      .values({
        id,
        teamId,
        targetKind,
        appId: targetKind === "app" ? targetId : null,
        databaseId: targetKind === "database" ? targetId : null,
        name: patch.name!,
        schedule: patch.schedule!,
        command: patch.command!,
        description: patch.description ?? "",
        service: patch.service ?? null,
        timezone: patch.timezone ?? "UTC",
        shell: patch.shell ?? "sh",
        enabled: patch.enabled ?? true,
        timeoutSeconds: patch.timeoutSeconds ?? 3600,
        maxAttempts: patch.maxAttempts ?? 1,
        overlap: patch.overlap ?? "skip",
        keepRuns: patch.keepRuns ?? 50,
        workdir: patch.workdir ?? null,
        user: patch.user ?? null,
        createdByUserId: user?.id ?? null,
        createdAt: now,
        updatedAt: now,
      });
  } catch (e) {
    // The unique index is the real check; catching it here turns a Postgres
    // constraint string into the sentence the form should show. The constraint
    // name lives on the driver error's `cause`, not on the message Drizzle
    // wraps it in, so match the whole chain.
    if (/cron_jobs_(app|database)_name_uq/.test(errorChainText(e))) {
      throw new Error(`A cron job called "${patch.name}" already exists here`);
    }
    throw e;
  }
  await writeEnv(id, env);
  await recordActivity(
    "cron",
    `Created cron job ${patch.name}`,
    user?.name ?? "Deplo",
    targetKind === "app" ? targetId : null,
    teamId,
  );
  return (await oneJob(id))!;
}

/** An error plus its `cause` chain as one string - where drivers hide details. */
function errorChainText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    parts.push(String(cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" ");
}

async function oneJob(id: string): Promise<CronJobDTO | null> {
  const rows = await getDb().select().from(cronJobsTable).where(eq(cronJobsTable.id, id)).limit(1);
  if (rows.length === 0) return null;
  const keys = await envKeysFor([id]);
  return toJobDTO(rows[0], keys.get(id) ?? []);
}

export async function updateCronJob(
  jobId: string,
  input: CronJobInput,
): Promise<CronJobDTO> {
  const { job, teamId } = await gateJob(jobId);
  const user = await getCurrentUser();
  const patch = buildPatch(input, job);
  if (Object.keys(patch).length > 0 || input.env !== undefined) {
    patch.updatedAt = nowIso();
    const rows = await getDb()
      .update(cronJobsTable)
      .set(patch)
      .where(and(eq(cronJobsTable.id, jobId), eq(cronJobsTable.teamId, teamId)))
      .returning({ id: cronJobsTable.id });
    if (rows.length === 0) throw new Error("Cron job not found");
  }
  if (input.env !== undefined) await writeEnv(jobId, validateEnv(input.env));
  await recordActivity(
    "cron",
    `Updated cron job ${patch.name ?? job.name}`,
    user?.name ?? "Deplo",
    job.appId,
    teamId,
  );
  return (await oneJob(jobId))!;
}

export async function deleteCronJob(jobId: string): Promise<void> {
  const { job, teamId } = await gateJob(jobId);
  const user = await getCurrentUser();
  const rows = await getDb()
    .delete(cronJobsTable)
    .where(and(eq(cronJobsTable.id, jobId), eq(cronJobsTable.teamId, teamId)))
    .returning({ id: cronJobsTable.id });
  if (rows.length === 0) throw new Error("Cron job not found");
  await recordActivity(
    "cron",
    `Deleted cron job ${job.name}`,
    user?.name ?? "Deplo",
    job.appId,
    teamId,
  );
}

/**
 * Run a job now, outside its schedule.
 *
 * Honours the target's master switch and nothing else: overlap is deliberately
 * ignored (somebody just pressed a button), but the switch means "no cron job
 * runs here", and the UI hides this page when it is off - so an API caller must
 * not be the one exception.
 */
export async function runCronJobNow(jobId: string): Promise<CronRunDTO> {
  const { job, teamId, targetEnabled } = await gateJob(jobId);
  if (!targetEnabled) {
    throw new Error("Cron jobs are switched off here. Turn them on in Settings first.");
  }
  const user = await getCurrentUser();
  const actor = user?.name ?? "Deplo";
  const schedulable = await loadSchedulableJob(jobId);
  if (!schedulable) throw new Error("Cron job not found");

  const r = await runJobNow(schedulable, actor);
  await recordActivity("cron", `Ran cron job ${job.name}`, actor, job.appId, teamId);
  // Re-read: startAttempt may already have settled it (a stopped container is a
  // `skipped` run before this call returns), and the caller renders the outcome.
  const rows = await getDb()
    .select()
    .from(cronRunsTable)
    .where(eq(cronRunsTable.id, r.run.id))
    .limit(1);
  return toRunDTO(rows[0] ?? r.run);
}

/** Stop a run that is in flight. */
export async function cancelCronRun(runId: string): Promise<void> {
  const teamId = await requireActiveTeamId();
  const r = await loadInFlightRun(runId);
  if (!r || r.run.teamId !== teamId) throw new Error("Run not found");
  await gateJob(r.job.id);
  const user = await getCurrentUser();
  const actor = user?.name ?? "Deplo";
  await cancelRun(r, actor);
  await recordActivity(
    "cron",
    `Stopped a run of cron job ${r.job.name}`,
    actor,
    r.job.appId,
    teamId,
  );
}
