import "server-only";

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
  dedupeKey?: string;
}

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
      command: job.command,
      timeoutSeconds: job.timeoutSeconds,
      maxAttempts: job.maxAttempts,
    })
    .onConflictDoNothing()
    .returning();
  const run = inserted[0];
  return run ? { run, job, target } : null;
}

// Reap must run before this: the overlap rule reads the running rows. Several matching minutes fire once, on the last.
export async function fireDueJobs(
  minutes: Date[],
  heartbeat: () => Promise<boolean> = async () => true,
): Promise<void> {
  const now = minutes[minutes.length - 1] ?? new Date();
  const jobs = await listSchedulableJobs();
  for (const schedulable of jobs) {
    if (!(await heartbeat())) return;
    const { job } = schedulable;
    try {
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
      if (!r) continue;

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

export async function cancelRun(r: InFlightRun, actor: string): Promise<void> {
  if (r.run.agentJobId) {
    try {
      const conn = await connectFn(r.target.serverId);
      try {
        await conn.killJob(r.run.agentJobId);
      } finally {
        conn.close();
      }
    } catch {}
  }
  await settle(r, "failed", { error: `Stopped by ${actor}.` });
}
