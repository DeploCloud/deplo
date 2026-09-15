import "server-only";

import { and, eq } from "drizzle-orm";

import { decryptSecretOrThrow } from "../../crypto";
import { getDb } from "../../db/client";
import {
  cronJobEnv as cronJobEnvTable,
  cronRuns as cronRunsTable,
} from "../../db/schema/control-plane/crons";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { agentMessage, connectFn } from "./agent";
import { deadlineOf, STALE_CLAIM_MS } from "./deadlines";
import { settle, settleOrRetry } from "./outcome";
import type { CronTarget, InFlightRun, JobRow } from "./targets";
import { listInFlightRuns } from "./targets";

// ponytail: serial in the fire phase - a job still going when the ladder runs out
let quickFinishPolls = [150, 250, 350, 500];

export function __setQuickFinishPolls(ms: number[]): void {
  quickFinishPolls = ms;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function jobEnv(
  jobId: string,
): Promise<{ name: string; value: string }[]> {
  const rows = await getDb()
    .select({ key: cronJobEnvTable.key, valueEnc: cronJobEnvTable.valueEnc })
    .from(cronJobEnvTable)
    .where(eq(cronJobEnvTable.jobId, jobId));
  return rows.map((r) => ({
    name: r.key,
    value: decryptSecretOrThrow(r.valueEnc, `The variable ${r.key}`),
  }));
}

async function resolveContainer(
  conn: AgentConnection,
  { job, target }: { job: JobRow; target: CronTarget },
): Promise<{ name: string; image: string } | null> {
  const instances = await conn.listInstances(target.projectId, target.slug, "");
  const running = instances.filter((i) => i.running);
  const pick = job.service
    ? running.find((i) => i.service === job.service)
    : (running.find((i) => i.service === target.primaryService) ?? running[0]);
  return pick ? { name: pick.name, image: pick.image } : null;
}

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
      .where(
        and(
          eq(cronRunsTable.id, r.run.id),
          eq(cronRunsTable.status, "running"),
        ),
      );

    const started: InFlightRun = {
      ...r,
      run: {
        ...r.run,
        agentJobId,
        container: container.name,
        nextAttemptAt: null,
      },
    };
    let elapsed = 0;
    for (const ms of quickFinishPolls) {
      await sleep(ms);
      elapsed += ms;
      const inFlight = await reapOne(
        conn,
        started,
        new Date(at.getTime() + elapsed),
      ).catch(() => false);
      if (!inFlight) return;
    }
  } catch (e) {
    await settleOrRetry(r, "failed", { error: agentMessage(e) }, at);
  }
}

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
          console.warn(
            `[crons] reaping run ${r.run.id} failed: ${agentMessage(e)}`,
          );
        }
      }
    } finally {
      conn.close();
    }
  }
}

async function reapOne(
  conn: AgentConnection,
  r: InFlightRun,
  now: Date,
): Promise<boolean> {
  if (!r.run.agentJobId) {
    if (r.run.nextAttemptAt) {
      if (now < new Date(r.run.nextAttemptAt)) return true;
    } else if (now.getTime() - Date.parse(r.run.startedAt) > STALE_CLAIM_MS) {
      await settle(
        r,
        "skipped",
        { error: "Deplo stopped before this run could start." },
        now,
      );
      return false;
    }
    await startAttempt(conn, r, now);
    return false;
  }

  const poll = await conn.pollJob(r.run.agentJobId);
  if (!poll.found) {
    await settle(
      r,
      "lost",
      { error: "The server's agent restarted while this run was in flight." },
      now,
    );
    return false;
  }

  if (poll.running) {
    if (now.getTime() <= deadlineOf(r.run)) return true;
    await conn.killJob(r.run.agentJobId).catch(() => {});
    await settleOrRetry(
      r,
      "timedout",
      {
        error: `The command was still running after ${r.run.timeoutSeconds} seconds and was stopped.`,
      },
      now,
    );
    return false;
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
    return false;
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
  return false;
}
