import { eq } from "drizzle-orm";

import type { TestDb } from "../db/test-harness";
import {
  apps as appsTable,
  cronJobs as cronJobsTable,
  cronRuns as cronRunsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import { TEAM_A } from "./identity-test-helpers";
import type { AgentConnection } from "../infra/agent-client";
import type { InFlightRun } from "../crons/runner";

/**
 * Seeders + a fake agent for the cron tests. Not named `*.test.ts` so the
 * `node --test` glob skips it.
 */

export const TRUNCATE_CRONS = `truncate table cron_runs, cron_job_env, cron_jobs
  restart identity cascade;`;

export interface SeedCronJobOpts {
  id: string;
  appId?: string;
  databaseId?: string;
  name?: string;
  schedule?: string;
  timezone?: string;
  command?: string;
  enabled?: boolean;
  service?: string | null;
  shell?: string;
  timeoutSeconds?: number;
  maxAttempts?: number;
  overlap?: string;
  keepRuns?: number;
  teamId?: string;
}

const T0 = "2026-01-01T00:00:00.000Z";

export async function seedCronJob(db: TestDb, opts: SeedCronJobOpts): Promise<string> {
  await db.insert(cronJobsTable).values({
    id: opts.id,
    teamId: opts.teamId ?? TEAM_A,
    targetKind: opts.databaseId ? "database" : "app",
    appId: opts.databaseId ? null : (opts.appId ?? "prj_1"),
    databaseId: opts.databaseId ?? null,
    name: opts.name ?? opts.id,
    description: "",
    service: opts.service ?? null,
    schedule: opts.schedule ?? "* * * * *",
    timezone: opts.timezone ?? "UTC",
    shell: opts.shell ?? "sh",
    command: opts.command ?? "echo hi",
    enabled: opts.enabled ?? true,
    timeoutSeconds: opts.timeoutSeconds ?? 3600,
    maxAttempts: opts.maxAttempts ?? 1,
    overlap: opts.overlap ?? "skip",
    keepRuns: opts.keepRuns ?? 50,
    workdir: null,
    user: null,
    createdByUserId: null,
    createdAt: T0,
    updatedAt: T0,
  });
  return opts.id;
}

/** Flip a target's master switch (both start off, like production). */
export async function enableCrons(
  db: TestDb,
  kind: "app" | "database",
  id: string,
): Promise<void> {
  if (kind === "app") {
    await db.update(appsTable).set({ cronEnabled: true }).where(eq(appsTable.id, id));
  } else {
    await db
      .update(databasesTable)
      .set({ cronEnabled: true })
      .where(eq(databasesTable.id, id));
  }
}

/** Every run of a job, oldest first — the history as the page shows it reversed. */
export async function runsOf(db: TestDb, jobId: string) {
  return db
    .select()
    .from(cronRunsTable)
    .where(eq(cronRunsTable.jobId, jobId))
    .orderBy(cronRunsTable.seq);
}

/** What the fake agent should answer for one job handle. */
export interface FakeJobState {
  found?: boolean;
  running?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

/**
 * A stand-in for a real agent connection.
 *
 * Only the four methods the cron runner uses are implemented; everything else on
 * `AgentConnection` throws if touched, which is the point — a test that reaches
 * for another RPC has found a coupling the runner should not have.
 */
export class FakeAgent {
  /** Containers the fake host is running, in ListInstances order. */
  instances: { name: string; service: string; image: string; running: boolean }[] = [
    { name: "deplo-web", service: "web", image: "img", running: true },
  ];
  /** job_id -> what PollJob answers. */
  jobs = new Map<string, FakeJobState>();
  /** Every StartJob it received, in order. */
  started: { container: string; command: string; shell: string; env: string[] }[] = [];
  killed: string[] = [];
  closed = 0;
  /** When set, connecting throws it — an unreachable or too-old agent. */
  connectError: Error | null = null;
  /** When set, StartJob throws it. */
  startError: Error | null = null;
  private seq = 0;

  connector = async (): Promise<AgentConnection> => {
    if (this.connectError) throw this.connectError;
    return this.connection();
  };

  /** Queue the answer PollJob gives for the NEXT started job. */
  nextState: FakeJobState = { found: true, running: true };

  /** An arrow property, so the RPC bodies below close over `this` lexically. */
  connection = (): AgentConnection => {
    const conn = {
      listInstances: async () =>
        this.instances.map((i) => ({
          ...i,
          exposed: false,
          user: "",
          workdir: "",
          openStdin: false,
          tty: false,
          state: i.running ? "running" : "exited",
          health: "",
          restartCount: 0,
        })),
      startJob: async (req: { container: string; command: string; shell: string; env: { name: string }[] }) => {
        if (this.startError) throw this.startError;
        const id = `agentjob_${++this.seq}`;
        this.started.push({
          container: req.container,
          command: req.command,
          shell: req.shell,
          env: req.env.map((e) => e.name),
        });
        this.jobs.set(id, { found: true, running: true, ...this.nextState });
        return id;
      },
      pollJob: async (jobId: string) => {
        const s = this.jobs.get(jobId) ?? { found: false };
        return {
          found: s.found ?? true,
          running: s.running ?? false,
          exitCode: s.exitCode ?? 0,
          stdout: s.stdout ?? "",
          stderr: s.stderr ?? "",
          timedOut: s.timedOut ?? false,
        };
      },
      killJob: async (jobId: string) => {
        this.killed.push(jobId);
        return true;
      },
      close: () => {
        this.closed++;
      },
    };
    // Only the cron surface is real; reaching for another RPC is a coupling bug,
    // not a gap in this fake. `then` and symbols are exempt: awaiting the object
    // probes for a thenable, and throwing there would turn every `await` into a
    // failure that says nothing about the code under test.
    return new Proxy(conn, {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        if (typeof prop === "symbol" || prop === "then") return undefined;
        throw new Error(`FakeAgent: the cron runner must not call ${String(prop)}`);
      },
    }) as unknown as AgentConnection;
  };

  /** Settle every live handle with one outcome. */
  settleAll(state: FakeJobState): void {
    for (const id of this.jobs.keys()) {
      this.jobs.set(id, { found: true, running: false, ...state });
    }
  }
}

/** The agent handle a run is currently attached to, or null. */
export function agentJobIdOf(r: InFlightRun): string | null {
  return r.run.agentJobId;
}
