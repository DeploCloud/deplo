import "server-only";

// https://deplo.build/docs/guides/observability/cron-jobs

import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../../db/client";
import { cronRuns as cronRunsTable } from "../../db/schema/control-plane/crons";
import { newId } from "../../ids";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { cronMatchesInZone, dedupeKeyFor } from "../cron-tz";
import { agentMessage, connectFn } from "./agent";
import { startAttempt } from "./attempt";
import { settle, settleOrRetry } from "./outcome";
import type { InFlightRun, SchedulableJob } from "./targets";
import { listSchedulableJobs } from "./targets";

async function hasOtherRunningRun(
  jobId: string,
  exceptId: string,
): Promise<boolean> {
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
  // Overrides the derived key - a manual run is not a scheduled minute.
  dedupeKey?: string;
}

// claimRun inserts the run row for one fire, or null when this fire already has one.
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
        opts.dedupeKey ??
        dedupeKeyFor(job.schedule, scheduledFor, job.timezone),
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

// fireDueJobs starts every job due in this window. A job matching several of them fires
// ONCE, on the last - late rather than not at all. Reap must precede fire: the overlap
// rule reads the `running` rows.
export async function fireDueJobs(
  minutes: Date[],
  heartbeat: () => Promise<boolean> = async () => true,
): Promise<void> {
  // The replay window always ENDS with the tick's own minute, so its last entry
  // is `now` - the deadlines a run is judged against come from one clock.
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

      if (
        job.overlap === "skip" &&
        (await hasOtherRunningRun(job.id, r.run.id))
      ) {
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

// runJobNow runs a job outside its schedule. "Skip this run" is a statement about the
// COMMAND, so a button press cannot be the one caller allowed to start the second copy.
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

  if (
    schedulable.job.overlap === "skip" &&
    (await hasOtherRunningRun(schedulable.job.id, r.run.id))
  ) {
    await settle(
      r,
      "skipped",
      { error: "The previous run was still in progress." },
      at,
    );
    return r;
  }

  let conn: AgentConnection;
  try {
    conn = await connectFn(schedulable.target.serverId);
  } catch (e) {
    // Settle before rethrowing. A `running` row nobody is running starves every later
    // fire under overlap=skip, and the next reap would LAUNCH the command - minutes
    // after a button press that answered with an error.
    await settle(r, "failed", { error: agentMessage(e) }, at);
    throw new Error(agentMessage(e));
  }
  try {
    await startAttempt(conn, r, at);
  } finally {
    conn.close();
  }
  return r;
}

// cancelRun stops an in-flight run. Best-effort on the agent, authoritative in the store.
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
