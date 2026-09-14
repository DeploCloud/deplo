import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  cronJobs as cronJobsTable,
  cronRuns as cronRunsTable,
} from "../../db/schema/control-plane/crons";
import { shouldFire } from "../../notify/cooldown";
import { dispatchAlert } from "../../notify/dispatch";
import type { CronRunStatus } from "../../types/cron";
import { RETRY_BACKOFF_MS } from "./deadlines";
import type { InFlightRun } from "./targets";

// CRON_OUTPUT_TAIL_BYTES is the retained output per stream, per run. Declared in
// agent.proto too, so the two cannot drift silently.
export const CRON_OUTPUT_TAIL_BYTES = 16 * 1024;

// tailOutput keeps the END of the output: a job's value is its last lines - the error,
// the summary - while its head is startup boilerplate.
export function tailOutput(s: string): string {
  if (s.length <= CRON_OUTPUT_TAIL_BYTES) return s;
  return `[deplo] earlier output trimmed\n${s.slice(-CRON_OUTPUT_TAIL_BYTES)}`;
}

export interface SettleFields {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string | null;
}

// settle writes a run's terminal status, prunes the job's history, and raises the alert.
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
      ...(fields.stdout !== undefined
        ? { stdout: tailOutput(fields.stdout) }
        : {}),
      ...(fields.stderr !== undefined
        ? { stderr: tailOutput(fields.stderr) }
        : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
    })
    .where(
      and(eq(cronRunsTable.id, r.run.id), eq(cronRunsTable.status, "running")),
    )
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

// `settle` is the ONLY caller, which is what makes "a retry alerts only on the last
// attempt" structural rather than a flag somebody can forget to pass.
function raiseAlert(
  r: InFlightRun,
  status: Exclude<CronRunStatus, "running">,
  fields: SettleFields,
): void {
  // A skipped run is not a failure: an app stopped on purpose must not page
  // anyone at 03:00. It is visible in the history and on the job's row instead.
  if (status === "skipped") return;

  // One repeated condition per job: an every-minute job that keeps failing says
  // so once per cooldown, not 1440 times a day.
  const dedupeId = `cron:${r.job.id}`;
  const attempts = r.run.attempt + 1;
  const tried = attempts > 1 ? ` after ${attempts} attempts` : "";
  if (status === "succeeded") {
    shouldFire("cron_job_failed", dedupeId, "ok");
    dispatchAlert({
      teamId: r.run.teamId,
      key: "cron_job_succeeded",
      title: `Cron job "${r.job.name}" finished`,
      body: `The command completed successfully${tried}.`,
      path: r.target.path,
      dedupe: { id: dedupeId, state: "ok" },
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
    dedupe: { id: dedupeId, state: status },
  });
}

// settleOrRetry settles, unless an attempt is left - then the row stays `running` with
// its agent handle cleared and a time to relaunch, and the next reap picks it up.
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
      .where(
        and(
          eq(cronRunsTable.id, r.run.id),
          eq(cronRunsTable.status, "running"),
        ),
      );
    return;
  }
  await settle(r, status, fields, at);
}

// pruneRuns drops the runs past this job's retention, ordered by `seq`: two runs can
// share a start minute, and `seq` is the only total order the table has.
export async function pruneRuns(
  jobId: string,
  keepRuns: number,
): Promise<void> {
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
