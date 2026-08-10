import "server-only";

import { and, eq, ne, or, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  cronJobEnv as cronJobEnvTable,
  cronJobs as cronJobsTable,
  cronRuns as cronRunsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import { decryptSecretOrThrow } from "../crypto";
import { newId } from "../ids";
import {
  AgentCronUnsupportedError,
  AgentUnreachableError,
  connectCronAgent,
  type AgentConnection,
} from "../infra/agent-client";
import { dispatchAlert } from "../notify/dispatch";
import type { CronRunStatus } from "../types";
import { cronMatchesInZone, dedupeKeyFor } from "./cron-tz";

/**
 * The mechanics of running a cron job - deliberately SESSION-FREE, exactly like
 * `lib/deploy/preview-lifecycle.ts` is for previews.
 *
 * The scheduler has no request identity: nobody is logged in at 03:00. So every
 * capability, team and folder check lives one layer up in `lib/data/crons.ts`,
 * and this module takes rows it is given and talks to agents. Nothing here calls
 * `requireCapability`, and nothing here may be reachable from a resolver without
 * going through that file first.
 *
 * Two entry points, and the ORDER between them is load-bearing:
 *
 *   1. {@link reapInFlightRuns} - poll what is already going, settle what ended.
 *   2. {@link fireDueJobs} - start what this minute calls for.
 *
 * Reap must precede fire, because the overlap rule reads the `running` rows. A
 * fire phase that ran first would see a run the agent finished ten seconds ago as
 * still in flight and skip a legitimate execution.
 */

/**
 * Retained output per stream, per run. Mirrors `cronOutputTailBytes` in the
 * agent's job.go, where the primary trim happens; this is the defensive second
 * one, because the ceiling is a contract an agent could regress on and these rows
 * render in a page. Declared in agent.proto so the two cannot drift silently.
 */
export const CRON_OUTPUT_TAIL_BYTES = 16 * 1024;

/** Fixed wait before a retry. Not exponential: a retrying run holds the job's
 *  `running` slot, and under overlap=skip a growing backoff would starve more
 *  and more scheduled fires the longer it went on. */
export const RETRY_BACKOFF_MS = 60_000;

/**
 * Slack past a run's OWN timeout before the control plane stops believing it.
 * The agent enforces `timeoutSeconds` itself; this covers the case where its
 * timer died with it.
 */
export const REAP_GRACE_MS = 120_000;

/**
 * How the runner reaches an agent. Overridable because every interesting path
 * here - a poll that says `found: false`, a retry ladder, a run outliving its
 * deadline - is a conversation with an agent, and there is no way to have that
 * conversation in a test against pglite otherwise.
 *
 * Same shape as the agent's own `traefikApply` override: production never touches
 * it, and the default is the real thing.
 */
let connectFn: (serverId: string) => Promise<AgentConnection> = connectCronAgent;

/** Test-only: swap the agent connector. */
export function __setCronConnector(
  fn: (serverId: string) => Promise<AgentConnection>,
): void {
  connectFn = fn;
}

/** Test-only: restore the real connector. */
export function __resetCronConnector(): void {
  connectFn = connectCronAgent;
}

/** Keep the END of the output: a job's value is its last lines - the error, the
 *  summary - while its head is startup boilerplate. */
export function tailOutput(s: string): string {
  if (s.length <= CRON_OUTPUT_TAIL_BYTES) return s;
  return `[deplo] earlier output trimmed\n${s.slice(-CRON_OUTPUT_TAIL_BYTES)}`;
}

type JobRow = typeof cronJobsTable.$inferSelect;
type RunRow = typeof cronRunsTable.$inferSelect;

/** A job plus the bits of its target the runner needs to reach a container. */
export interface CronTarget {
  serverId: string;
  /** The `deplo.project` label: the app's or database's id. */
  projectId: string;
  /** The stack slug the agent lists instances for (a database's is its host). */
  slug: string;
  /** For an app, its own compose service - the default container to pick. */
  primaryService: string;
  /** Where the UI shows this job, for the alert link. */
  path: string;
}

export interface SchedulableJob {
  job: JobRow;
  target: CronTarget;
}

/** Assemble a target from the joined columns, or null when the target is gone. */
function targetOf(
  job: JobRow,
  app: { slug: string; serverId: string } | null,
  db: { host: string; serverId: string } | null,
): CronTarget | null {
  if (job.appId && app) {
    return {
      serverId: app.serverId,
      projectId: job.appId,
      slug: app.slug,
      primaryService: app.slug,
      path: `/apps/${app.slug}/cron-jobs`,
    };
  }
  if (job.databaseId && db) {
    return {
      serverId: db.serverId,
      projectId: job.databaseId,
      // A database is a single-container stack whose container_name IS its host.
      slug: db.host,
      primaryService: db.host,
      path: `/storage/databases/${job.databaseId}/cron-jobs`,
    };
  }
  return null;
}

const targetColumns = {
  job: cronJobsTable,
  appSlug: appsTable.slug,
  appServerId: appsTable.serverId,
  dbHost: databasesTable.host,
  dbServerId: databasesTable.serverId,
};

function assembleTarget(r: {
  job: JobRow;
  appSlug: string | null;
  appServerId: string | null;
  dbHost: string | null;
  dbServerId: string | null;
}): CronTarget | null {
  return targetOf(
    r.job,
    r.appSlug && r.appServerId ? { slug: r.appSlug, serverId: r.appServerId } : null,
    r.dbHost && r.dbServerId ? { host: r.dbHost, serverId: r.dbServerId } : null,
  );
}

/**
 * Every job the scheduler may fire: enabled, on a target whose own cron switch is
 * on. The second half is what makes the master switch a real pause button - the
 * jobs survive, the schedule stops.
 */
export async function listSchedulableJobs(): Promise<SchedulableJob[]> {
  const rows = await getDb()
    .select(targetColumns)
    .from(cronJobsTable)
    .leftJoin(appsTable, eq(appsTable.id, cronJobsTable.appId))
    .leftJoin(databasesTable, eq(databasesTable.id, cronJobsTable.databaseId))
    .where(
      and(
        eq(cronJobsTable.enabled, true),
        or(eq(appsTable.cronEnabled, true), eq(databasesTable.cronEnabled, true)),
      ),
    );
  const out: SchedulableJob[] = [];
  for (const r of rows) {
    const target = assembleTarget(r);
    if (target) out.push({ job: r.job, target });
  }
  return out;
}

/** One in-flight run, with everything needed to poll or relaunch it. */
export interface InFlightRun {
  run: RunRow;
  job: JobRow;
  target: CronTarget;
}

/** Every `running` run - the reaper's whole working set (partial index). */
export async function listInFlightRuns(): Promise<InFlightRun[]> {
  const rows = await getDb()
    .select({ run: cronRunsTable, ...targetColumns })
    .from(cronRunsTable)
    .innerJoin(cronJobsTable, eq(cronJobsTable.id, cronRunsTable.jobId))
    .leftJoin(appsTable, eq(appsTable.id, cronJobsTable.appId))
    .leftJoin(databasesTable, eq(databasesTable.id, cronJobsTable.databaseId))
    .where(eq(cronRunsTable.status, "running"));
  const out: InFlightRun[] = [];
  for (const r of rows) {
    const target = assembleTarget(r);
    if (target) out.push({ run: r.run, job: r.job, target });
  }
  return out;
}

/** When the control plane stops believing a run is still going. */
export function deadlineOf(run: RunRow): number {
  return Date.parse(run.startedAt) + run.timeoutSeconds * 1000 + REAP_GRACE_MS;
}

/* ------------------------------------------------------------------ */
/* Settling                                                            */
/* ------------------------------------------------------------------ */

interface SettleFields {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string | null;
}

/**
 * Write a run's terminal status, prune the job's history, and raise the alert.
 *
 * The `WHERE status = 'running'` plus the row count is what makes a double alert
 * impossible: two control-plane instances can both decide a run ended, but only
 * one UPDATE changes a row.
 */
export async function settle(
  r: InFlightRun,
  status: Exclude<CronRunStatus, "running">,
  fields: SettleFields = {},
  at: Date = new Date(),
): Promise<boolean> {
  const now = at.toISOString();
  const done = await getDb()
    .update(cronRunsTable)
    .set({
      status,
      finishedAt: now,
      agentJobId: null,
      nextAttemptAt: null,
      ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
      ...(fields.stdout !== undefined ? { stdout: tailOutput(fields.stdout) } : {}),
      ...(fields.stderr !== undefined ? { stderr: tailOutput(fields.stderr) } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
    })
    .where(and(eq(cronRunsTable.id, r.run.id), eq(cronRunsTable.status, "running")))
    .returning({ id: cronRunsTable.id });
  if (done.length === 0) return false; // somebody else settled it first

  await getDb()
    .update(cronJobsTable)
    .set({
      lastRunAt: now,
      lastStatus: status,
      ...(status === "succeeded" ? { lastSuccessAt: now } : {}),
    })
    .where(eq(cronJobsTable.id, r.job.id));

  await pruneRuns(r.job.id, r.job.keepRuns);
  raiseAlert(r, status, fields);
  return true;
}

/**
 * The alert half of settling. Off in its own function because `settle` is the
 * ONLY caller - which is what makes "a retry alerts only on the last attempt"
 * structural rather than a flag somebody can forget to pass.
 */
function raiseAlert(
  r: InFlightRun,
  status: Exclude<CronRunStatus, "running">,
  fields: SettleFields,
): void {
  // A skipped run is not a failure: an app stopped on purpose must not page
  // anyone at 03:00. It is visible in the history and on the job's row instead.
  if (status === "skipped") return;

  const attempts = r.run.attempt + 1;
  const tried = attempts > 1 ? ` after ${attempts} attempts` : "";
  if (status === "succeeded") {
    dispatchAlert({
      teamId: r.run.teamId,
      key: "cron_job_succeeded",
      title: `Cron job "${r.job.name}" finished`,
      body: `The command completed successfully${tried}.`,
      path: r.target.path,
    });
    return;
  }
  const body =
    status === "lost"
      ? `${fields.error ?? "Deplo lost track of this run."} The command may or may not have completed.`
      : status === "timedout"
        ? `The command was still running after ${r.run.timeoutSeconds} seconds and was stopped${tried}.`
        : `${fields.error ?? `The command exited with code ${fields.exitCode ?? "?"}`}${tried}.`;
  dispatchAlert({
    teamId: r.run.teamId,
    key: "cron_job_failed",
    title:
      status === "lost"
        ? `Cron job "${r.job.name}": outcome unknown`
        : `Cron job "${r.job.name}" failed`,
    body,
    path: r.target.path,
  });
}

/**
 * Settle, unless there is another attempt left - in which case the row stays
 * `running` with its agent handle cleared and a time to relaunch, and the next
 * reap picks it up.
 *
 * A retry therefore never writes a terminal status, so one scheduled fire is
 * always exactly one row in the history. The cost, stated rather than hidden: the
 * stored output is overwritten by each attempt, so only the last one's survives.
 */
export async function settleOrRetry(
  r: InFlightRun,
  status: Exclude<CronRunStatus, "running" | "skipped">,
  fields: SettleFields,
  at: Date = new Date(),
): Promise<void> {
  // `lost` never retries: we do not know that the command failed - we know we
  // stopped watching. Running it again could double-charge a card.
  const retryable = status === "failed" || status === "timedout";
  if (retryable && r.run.attempt + 1 < r.run.maxAttempts) {
    await getDb()
      .update(cronRunsTable)
      .set({
        agentJobId: null,
        attempt: r.run.attempt + 1,
        nextAttemptAt: new Date(at.getTime() + RETRY_BACKOFF_MS).toISOString(),
        exitCode: fields.exitCode ?? null,
        stdout: tailOutput(fields.stdout ?? ""),
        stderr: tailOutput(fields.stderr ?? ""),
        error: fields.error ?? null,
      })
      .where(and(eq(cronRunsTable.id, r.run.id), eq(cronRunsTable.status, "running")));
    return;
  }
  await settle(r, status, fields, at);
}

/**
 * Drop the runs past this job's retention. Ordered by `seq` and not by a
 * timestamp: two runs can share a start minute, and `seq` is the only total
 * order the table has.
 */
export async function pruneRuns(jobId: string, keepRuns: number): Promise<void> {
  await getDb().execute(sql`
    delete from ${cronRunsTable}
    where ${cronRunsTable.jobId} = ${jobId}
      and ${cronRunsTable.id} not in (
        select id from ${cronRunsTable}
        where ${cronRunsTable.jobId} = ${jobId}
        order by ${cronRunsTable.seq} desc
        limit ${keepRuns}
      )`);
}

/* ------------------------------------------------------------------ */
/* Launching                                                           */
/* ------------------------------------------------------------------ */

/** The job's extra environment, decrypted at the edge and never before. */
async function jobEnv(jobId: string): Promise<{ name: string; value: string }[]> {
  const rows = await getDb()
    .select({ key: cronJobEnvTable.key, valueEnc: cronJobEnvTable.valueEnc })
    .from(cronJobEnvTable)
    .where(eq(cronJobEnvTable.jobId, jobId));
  // Strict for the same reason the deploy edge is: this becomes the job's
  // environment, and a job that runs with a blank credential does its damage
  // quietly and on a schedule.
  return rows.map((r) => ({
    name: r.key,
    value: decryptSecretOrThrow(r.valueEnc, `The variable ${r.key}`),
  }));
}

/**
 * The container this attempt should run in, resolved LIVE. Never read back from
 * the run row: a redeploy between two attempts mints new container names, and a
 * retry must land in the new one.
 *
 * Null means there is nothing to exec into - the stack is down, or the named
 * service is not up. The caller records a `skipped` run, not a failure.
 */
async function resolveContainer(
  conn: AgentConnection,
  { job, target }: { job: JobRow; target: CronTarget },
): Promise<{ name: string; image: string } | null> {
  const instances = await conn.listInstances(target.projectId, target.slug, "");
  const running = instances.filter((i) => i.running);
  const pick = job.service
    ? running.find((i) => i.service === job.service)
    : // No service named: the target's own container first (a crash-looping app
      // whose Postgres sidecar is healthy must not silently run its job in
      // Postgres), then whatever else is up.
      (running.find((i) => i.service === target.primaryService) ?? running[0]);
  return pick ? { name: pick.name, image: pick.image } : null;
}

/**
 * Launch one attempt of a run: resolve the container, ask the agent to start the
 * command, and record the handle. Settles the run itself on every failure, so the
 * caller never has to.
 *
 * `conn` is passed in because the reaper already has one open for that server.
 */
export async function startAttempt(
  conn: AgentConnection,
  r: InFlightRun,
  at: Date = new Date(),
): Promise<void> {
  let container: { name: string; image: string } | null;
  try {
    container = await resolveContainer(conn, r);
  } catch (e) {
    await settleOrRetry(r, "failed", { error: agentMessage(e) }, at);
    return;
  }
  if (!container) {
    // Not a failure. A stopped app is usually stopped on purpose, and paging
    // somebody about it every minute would train them to ignore the alerts.
    await settle(
      r,
      "skipped",
      {
        error: r.job.service
          ? `The "${r.job.service}" container was not running.`
          : "The container was not running.",
      },
      at,
    );
    return;
  }

  try {
    const env = await jobEnv(r.job.id);
    const agentJobId = await conn.startJob({
      projectId: r.target.projectId,
      container: container.name,
      image: container.image,
      shell: r.job.shell,
      command: r.run.command,
      timeoutSeconds: r.run.timeoutSeconds,
      workdir: r.job.workdir ?? "",
      user: r.job.user ?? "",
      env,
    });
    await getDb()
      .update(cronRunsTable)
      .set({ agentJobId, container: container.name, nextAttemptAt: null })
      .where(and(eq(cronRunsTable.id, r.run.id), eq(cronRunsTable.status, "running")));
  } catch (e) {
    await settleOrRetry(r, "failed", { error: agentMessage(e) }, at);
  }
}

function agentMessage(e: unknown): string {
  if (e instanceof AgentCronUnsupportedError) return e.message;
  if (e instanceof AgentUnreachableError) return `The server could not be reached: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------------------------------------------ */
/* Reaping                                                             */
/* ------------------------------------------------------------------ */

/**
 * Poll every in-flight run and settle what has ended, one agent connection per
 * server. `heartbeat` is called between servers so the caller can renew its
 * scheduler lease mid-drain; returning false stops the drain (the lease was
 * stolen, and racing the new owner is worse than stopping).
 */
export async function reapInFlightRuns(
  now: Date,
  heartbeat: () => Promise<boolean> = async () => true,
): Promise<void> {
  const runs = await listInFlightRuns();
  const byServer = new Map<string, InFlightRun[]>();
  for (const r of runs) {
    const list = byServer.get(r.target.serverId);
    if (list) list.push(r);
    else byServer.set(r.target.serverId, [r]);
  }

  for (const [serverId, group] of byServer) {
    if (!(await heartbeat())) return;

    let conn: AgentConnection;
    try {
      conn = await connectFn(serverId);
    } catch (e) {
      // Unreachable or too old. Do NOT settle anything that still has time on
      // the clock: the command is almost certainly still running over there, and
      // a `lost` we invent now is a lie we would have to take back. Only a run
      // that has outlived its own timeout is genuinely unaccounted for.
      for (const r of group) {
        if (now.getTime() > deadlineOf(r.run)) {
          await settle(
            r,
            "lost",
            {
              error: `${agentMessage(e)} This run passed its timeout while the server was unreachable.`,
            },
            now,
          );
        }
      }
      continue;
    }

    try {
      for (const r of group) {
        try {
          await reapOne(conn, r, now);
        } catch (e) {
          console.warn(`[crons] reaping run ${r.run.id} failed: ${agentMessage(e)}`);
        }
      }
    } finally {
      conn.close();
    }
  }
}

async function reapOne(conn: AgentConnection, r: InFlightRun, now: Date): Promise<void> {
  // No agent handle: this is a retry waiting out its backoff. Nothing to poll.
  if (!r.run.agentJobId) {
    if (r.run.nextAttemptAt && now < new Date(r.run.nextAttemptAt)) return;
    await startAttempt(conn, r, now);
    return;
  }

  const poll = await conn.pollJob(r.run.agentJobId);
  if (!poll.found) {
    // The agent restarted under us. NOT a failure - the command very likely
    // completed; we simply stopped being able to find out. See ADR-0018 §2.
    await settle(
      r,
      "lost",
      { error: "The server's agent restarted while this run was in flight." },
      now,
    );
    return;
  }

  if (poll.running) {
    if (now.getTime() <= deadlineOf(r.run)) return; // healthy: no write at all
    // Past our own deadline while the agent still says running: its timer died.
    await conn.killJob(r.run.agentJobId).catch(() => {});
    await settleOrRetry(
      r,
      "timedout",
      {
        error: `The command was still running after ${r.run.timeoutSeconds} seconds and was stopped.`,
      },
      now,
    );
    return;
  }

  const status: "succeeded" | "failed" | "timedout" = poll.timedOut
    ? "timedout"
    : poll.exitCode === 0
      ? "succeeded"
      : "failed";
  if (status === "succeeded") {
    await settle(
      r,
      "succeeded",
      {
        exitCode: poll.exitCode,
        stdout: poll.stdout,
        stderr: poll.stderr,
        error: null,
      },
      now,
    );
    return;
  }
  await settleOrRetry(
    r,
    status,
    {
      exitCode: poll.exitCode,
      stdout: poll.stdout,
      stderr: poll.stderr,
      error:
        poll.exitCode === -1
          ? poll.stderr.trim() || "The command could not be started."
          : null,
    },
    now,
  );
}

/* ------------------------------------------------------------------ */
/* Firing                                                              */
/* ------------------------------------------------------------------ */

/** Is another run of this job still going? The overlap question. */
async function hasOtherRunningRun(jobId: string, exceptId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: cronRunsTable.id })
    .from(cronRunsTable)
    .where(
      and(
        eq(cronRunsTable.jobId, jobId),
        eq(cronRunsTable.status, "running"),
        ne(cronRunsTable.id, exceptId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface ClaimOptions {
  trigger: "schedule" | "manual";
  actor: string;
  /** Overrides the derived key - a manual run is not a scheduled minute. */
  dedupeKey?: string;
}

/**
 * Insert the run row for one fire, or null when this fire already has one.
 *
 * This INSERT is the serialization point for the whole feature. `UNIQUE(job_id,
 * dedupe_key)` means two control-plane instances racing on a stolen lease produce
 * exactly one row, and it is why the overlap check happens AFTER the insert:
 * decided before, both instances would read "nothing running" and both would fire.
 */
export async function claimRun(
  { job, target }: SchedulableJob,
  scheduledFor: Date,
  opts: ClaimOptions,
  at: Date = new Date(),
): Promise<InFlightRun | null> {
  const now = at.toISOString();
  const inserted = await getDb()
    .insert(cronRunsTable)
    .values({
      id: newId("cronrun"),
      teamId: job.teamId,
      jobId: job.id,
      status: "running",
      trigger: opts.trigger,
      actor: opts.actor,
      scheduledFor: scheduledFor.toISOString(),
      dedupeKey:
        opts.dedupeKey ?? dedupeKeyFor(job.schedule, scheduledFor, job.timezone),
      startedAt: now,
      attempt: 0,
      // Frozen at insert: editing the job mid-flight must not move the deadline
      // the reaper enforces, and the history must record what actually ran.
      command: job.command,
      timeoutSeconds: job.timeoutSeconds,
      maxAttempts: job.maxAttempts,
    })
    .onConflictDoNothing()
    .returning();
  const run = inserted[0];
  return run ? { run, job, target } : null;
}

/**
 * Start every job due in this window.
 *
 * `minutes` is the replay window: the tick's own minute plus any the previous
 * drain stepped over. A job matching several of them fires ONCE, on the last -
 * late rather than not at all, and never N times for one overrun.
 *
 * There is deliberately no catch-up for a Deplo that was DOWN. A job that missed
 * 04:00 because the panel was off should not run at 09:00: the user picked a
 * wall-clock time, and half of them picked it because of what else happens then.
 */
export async function fireDueJobs(
  minutes: Date[],
  heartbeat: () => Promise<boolean> = async () => true,
): Promise<void> {
  // The replay window always ENDS with the tick's own minute, so its last entry
  // is `now` - no extra parameter, and the deadlines a run is later judged
  // against are stamped from the same clock the tick reasons with.
  const now = minutes[minutes.length - 1] ?? new Date();
  const jobs = await listSchedulableJobs();
  for (const schedulable of jobs) {
    if (!(await heartbeat())) return;
    const { job } = schedulable;
    try {
      // A bad timezone throws out of `cronMatchesInZone`. Contained per job: one
      // row written by something that bypassed validation must not stop the
      // instance's other jobs from running.
      const fireAt = minutes
        .filter((m) => cronMatchesInZone(job.schedule, m, job.timezone))
        .pop();
      if (!fireAt) continue;

      const r = await claimRun(
        schedulable,
        fireAt,
        { trigger: "schedule", actor: "Scheduler" },
        now,
      );
      if (!r) continue; // already fired for this minute

      if (job.overlap === "skip" && (await hasOtherRunningRun(job.id, r.run.id))) {
        await settle(
          r,
          "skipped",
          { error: "The previous run was still in progress." },
          now,
        );
        continue;
      }

      let conn: AgentConnection;
      try {
        conn = await connectFn(schedulable.target.serverId);
      } catch (e) {
        await settleOrRetry(r, "failed", { error: agentMessage(e) }, now);
        continue;
      }
      try {
        await startAttempt(conn, r, now);
      } finally {
        conn.close();
      }
    } catch (e) {
      console.warn(`[crons] job ${job.id} failed to fire: ${agentMessage(e)}`);
    }
  }
}

/**
 * Load one job with its target, for the manual "Run now" path. Returns null when
 * the job is gone or its target is.
 */
export async function loadSchedulableJob(jobId: string): Promise<SchedulableJob | null> {
  const rows = await getDb()
    .select(targetColumns)
    .from(cronJobsTable)
    .leftJoin(appsTable, eq(appsTable.id, cronJobsTable.appId))
    .leftJoin(databasesTable, eq(databasesTable.id, cronJobsTable.databaseId))
    .where(eq(cronJobsTable.id, jobId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const target = assembleTarget(r);
  return target ? { job: r.job, target } : null;
}

/**
 * Run a job now, outside its schedule.
 *
 * Deliberately ignores `overlap`: somebody just pressed a button, and answering
 * "no, something else is running" to an explicit request is the wrong side of
 * that trade. The scheduled path still honours it.
 */
export async function runJobNow(
  schedulable: SchedulableJob,
  actor: string,
): Promise<InFlightRun> {
  const at = new Date();
  const r = await claimRun(schedulable, at, {
    trigger: "manual",
    actor,
    dedupeKey: `manual:${at.toISOString()}`,
  });
  if (!r) throw new Error("A run for this job is already starting");

  const conn = await connectFn(schedulable.target.serverId);
  try {
    await startAttempt(conn, r);
  } finally {
    conn.close();
  }
  return r;
}

/** Stop an in-flight run. Best-effort on the agent, authoritative in the store. */
export async function cancelRun(r: InFlightRun, actor: string): Promise<void> {
  if (r.run.agentJobId) {
    try {
      const conn = await connectFn(r.target.serverId);
      try {
        await conn.killJob(r.run.agentJobId);
      } finally {
        conn.close();
      }
    } catch {
      // An unreachable agent must not block the cancel: the row is what the
      // scheduler reads, and leaving it `running` would starve every later fire
      // under overlap=skip. The command may outlive this; the message says so.
    }
  }
  await settle(r, "failed", { error: `Stopped by ${actor}.` });
}

/** One in-flight run by id, for the cancel path. */
export async function loadInFlightRun(runId: string): Promise<InFlightRun | null> {
  const rows = await getDb()
    .select({ run: cronRunsTable, ...targetColumns })
    .from(cronRunsTable)
    .innerJoin(cronJobsTable, eq(cronJobsTable.id, cronRunsTable.jobId))
    .leftJoin(appsTable, eq(appsTable.id, cronJobsTable.appId))
    .leftJoin(databasesTable, eq(databasesTable.id, cronJobsTable.databaseId))
    .where(and(eq(cronRunsTable.id, runId), eq(cronRunsTable.status, "running")))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const target = assembleTarget(r);
  return target ? { run: r.run, job: r.job, target } : null;
}
