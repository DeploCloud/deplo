import { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { monitoringSettings } from "../../db/schema/control-plane/instance";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { seedIdentity, TEAM_A, USER_1 } from "../../data/identity-test-helpers";
import { __resetMonitoringSettingsMemo } from "../../data/monitoring-settings";
import { pubSub } from "../../graphql/pubsub";
import type { AgentConnection } from "../../infra/agent-client/connection";
import type {
  ContainerStat,
  HelloResponse,
  MetricsSample,
} from "../../agent/gen/agent";
import { clearMetricsHistory } from "../history";
import { clearContainerHistory } from "../container-history";
import {
  __setMetricsConnectorForTest,
  __streamModes,
  startMetricsStreams,
  stopMetricsStreams,
} from "../supervisor";

export const SRV_A = "srv_a";
export const SRV_B = "srv_b";

export type Harness = { db: TestDb; pg: PGlite };

export function setupSupervisor(): Harness {
  const h = {} as Harness;

  before(async () => {
    const made = await makeTestDb();
    h.db = made.db;
    h.pg = made.pg;
    __setTestDb(made.db);
    globalThis.fetch = (() =>
      Promise.reject(new Error("network disabled in tests"))) as typeof fetch;
  });

  after(async () => {
    __resetTestDb();
    await h.pg.close();
  });

  beforeEach(async () => {
    await h.pg.exec(
      `truncate table deployments, apps, databases, monitoring_settings, servers, activities, users, teams restart identity cascade;`,
    );
    await seedIdentity(h.db, {
      users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
    });
    clearMetricsHistory();
    clearContainerHistory();
    __resetMonitoringSettingsMemo();
    delete process.env.DEPLO_MONITORING_FORCE_POLL;
  });

  afterEach(async () => {
    const stopped = stopMetricsStreams();
    endAllFeeds();
    await stopped;
    __setMetricsConnectorForTest();
    delete process.env.DEPLO_MONITORING_FORCE_POLL;
  });

  return h;
}

export async function seedEnrolledServer(
  db: TestDb,
  id: string,
  createdAt: string,
): Promise<void> {
  await db
    .insert(serversTable)
    .values({
      id,
      name: id,
      host: "10.0.0.1",
      type: "remote",
      status: "online",
      ip: "10.0.0.1",
      dockerVersion: "27",
      traefikEnabled: true,
      cpuCores: 4,
      memoryMb: 8192,
      diskGb: 100,
      agentPort: 9443,
      agentCertFingerprint: `fp_${id}`,
      agentCertPem: "pem",
      agentVersion: "1.10.0",
      createdAt,
    })
    .onConflictDoNothing();
}

export async function disableSaving(db: TestDb): Promise<void> {
  await db
    .insert(monitoringSettings)
    .values({
      id: "default",
      saveMetrics: false,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: monitoringSettings.id,
      set: { saveMetrics: false },
    });
  __resetMonitoringSettingsMemo();
}

export function hello(over: Partial<HelloResponse> = {}): HelloResponse {
  return {
    contractVersion: 1,
    agentVersion: "1.10.0",
    dockerAvailable: true,
    dockerVersion: "27",
    capabilities: ["metrics-stream", "container-stats"],
    traefikRunning: true,
    hostArch: "amd64",
    ...over,
  };
}

export function containerStat(
  projectId: string,
  name: string,
  cpu: number,
  over: Partial<ContainerStat> = {},
): ContainerStat {
  return {
    name,
    cpuPct: cpu,
    memUsed: 100,
    memLimit: 1000,
    memPct: 10,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 3,
    running: true,
    projectId,
    containerId: `cid_${name}`,
    state: "running",
    health: "",
    restartCount: 0,
    netNsId: 0,
    netNsHost: false,
    oomKills: 0,
    ...over,
  };
}

export function frame(containers: ContainerStat[] = []): MetricsSample {
  return {
    host: {
      cpu: 12,
      cpuCores: 4,
      memUsed: 1_000,
      memTotal: 4_000,
      memPct: 25,
      memFree: 2_000,
      memCache: 1_000,
      diskUsed: 10,
      diskTotal: 100,
      diskPct: 10,
      netRx: 1,
      netTx: 2,
      load1: 0.1,
      load5: 0.2,
      load15: 0.3,
      uptimeSec: 3600,
      runningContainers: containers.length,
    },
    containers,
    sampledAtUnixMs: 0,
    source: "cgroup2",
  };
}

const liveFeeds: Feed[] = [];

function endAllFeeds(): void {
  for (const f of liveFeeds.splice(0)) f.end();
}

export class Feed {
  private queue: MetricsSample[] = [];
  private waiting: (() => void) | null = null;
  private consumed: (() => void) | null = null;
  private ended = false;
  closed = false;

  constructor() {
    liveFeeds.push(this);
  }

  async *stream(): AsyncGenerator<MetricsSample, void, unknown> {
    for (;;) {
      if (this.queue.length === 0) {
        if (this.ended) return;
        await new Promise<void>((r) => {
          this.waiting = r;
        });
        if (this.queue.length === 0) return;
      }
      yield this.queue.shift()!;
      const done = this.consumed;
      this.consumed = null;
      done?.();
    }
  }

  send(f: MetricsSample): Promise<void> {
    return new Promise<void>((resolve) => {
      this.consumed = resolve;
      this.queue.push(f);
      const w = this.waiting;
      this.waiting = null;
      w?.();
    });
  }

  end(): void {
    this.ended = true;
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  connection(): AgentConnection {
    return {
      streamMetrics: () => this.stream(),
      close: () => {
        this.closed = true;
        this.end();
      },
    } as unknown as AgentConnection;
  }
}

export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  what: string,
  ticks = 400,
): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

export async function statusCheckedAt(
  db: TestDb,
  id: string,
): Promise<string | null> {
  const [row] = await db
    .select({ at: serversTable.statusCheckedAt })
    .from(serversTable)
    .where(eq(serversTable.id, id));
  return row?.at ?? null;
}

export async function appRow(
  db: TestDb,
  id: string,
): Promise<{ status: string; updatedAt: string }> {
  const [row] = await db
    .select({ status: appsTable.status, updatedAt: appsTable.updatedAt })
    .from(appsTable)
    .where(eq(appsTable.id, id));
  assert.ok(row, `app ${id} should exist`);
  return row;
}

export function countPings(appId: string): {
  count: () => number;
  stop: () => void;
} {
  const it = pubSub.subscribe("appChanged", appId)[Symbol.asyncIterator]();
  let n = 0;
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const { done } = await it.next();
      if (done) return;
      n++;
    }
  })();
  return {
    count: () => n,
    stop: () => {
      stopped = true;
      void it.return?.(undefined);
    },
  };
}

export async function streamingServer(db: TestDb, id = SRV_A): Promise<Feed> {
  await seedEnrolledServer(db, id, "2026-01-01T00:00:00.000Z");
  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({
    conn: feed.connection(),
    hello: hello(),
  }));
  startMetricsStreams();
  await waitFor(() => __streamModes()[id] === "stream", `${id} to stream`);
  return feed;
}
