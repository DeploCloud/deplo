import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  cronJobs as cronJobsTable,
  cronRuns as cronRunsTable,
} from "../../db/schema/control-plane/crons";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { shouldFire } from "../../notify/cooldown";
import { dispatchAlert } from "../../notify/dispatch";
import type { CronRunStatus } from "../../types/cron";
import { RETRY_BACKOFF_MS } from "./deadlines";
import type { InFlightRun } from "./targets";

export const CRON_OUTPUT_TAIL_BYTES = 16 * 1024;

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
  if (done.length === 0) return false;

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

function raiseAlert(
  r: InFlightRun,
  status: Exclude<CronRunStatus, "running">,
  fields: SettleFields,
): void {
  if (status === "skipped") return;
  if (status === "server_lost") {
    dispatchAlert({
      teamId: r.run.teamId,
      key: "cron_run_lost",
      title: `Cron job "${r.job.name}" was lost: its server stopped`,
      body: `${fields.error ?? "Its server stopped while this run was in flight."} The command may be half done. Deplo does not run it again on its own: use Run now if it should run.`,
      path: r.target.path,
      appId: r.job.appId,
      dedupe: { id: `cronrun:${r.run.id}`, state: "lost" },
    });
    return;
  }

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
      appId: r.job.appId,
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
    appId: r.job.appId,
    dedupe: { id: dedupeId, state: status },
  });
}

/** The run's server stopped under it: lost for good, alerted once, never retried (spec #176). */
export async function settleServerLost(
  r: InFlightRun,
  serverId: string,
  at: Date = new Date(),
): Promise<void> {
  const [server] = await getDb()
    .select({ name: serversTable.name })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  await settle(
    r,
    "server_lost",
    {
      error: `${server?.name ?? "Its server"} stopped while this run was in flight.`,
    },
    at,
  );
}

export async function settleOrRetry(
  r: InFlightRun,
  status: Exclude<CronRunStatus, "running" | "skipped" | "server_lost">,
  fields: SettleFields,
  at: Date = new Date(),
): Promise<void> {
  // "lost" never retries: the command probably finished and we only stopped watching, so a rerun could double-charge.
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
