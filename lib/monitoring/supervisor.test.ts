import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  monitoringSettings,
  servers as serversTable,
} from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { seedApp } from "../data/app-graph-test-helpers";
import { seedDatabase } from "../data/backup-test-helpers";
import { __resetMonitoringSettingsMemo } from "../data/monitoring-settings";
import { AgentMetricsStreamUnsupportedError } from "../infra/agent-client";
import type { AgentConnection } from "../infra/agent-client";
import type {
  ContainerStat,
  HelloResponse,
  MetricsSample,
} from "../agent/gen/agent";
import { clearMetricsHistory, getMetricsHistory } from "./history";
import {
  clearContainerHistory,
  getContainerHistory,
  latestContainerInstances,
} from "./container-history";
import {
  HEALTH_WRITE_MS,
  STREAM_INTERVAL_MS,
  RECONNECT_BACKOFF_CAP_MS,
  __setMetricsConnectorForTest,
  __streamModes,
  backoffFor,
  startMetricsStreams,
  stopMetricsStreams,
} from "./supervisor";

/**
 * The metrics stream SUPERVISOR — the control flow the polling collector it
 * replaced never had a test for at all (`runMetricsCollectorTick` was exported
 * "for tests" and nothing ever called it).
 *
 * Everything here is driven through the ONE seam the module exposes,
 * `__setMetricsConnectorForTest`: a fake agent connection whose `streamMetrics`
 * generator the test pumps frame by frame, so each assertion lands at a known
 * point in the loop instead of racing a timer. The database underneath is real
 * pglite — the health heartbeat goes through the genuine `recordServerHealth`
 * path, because the fence and the throttle it has to respect live there.
 */

let db: TestDb;
let pg: PGlite;

const SRV_A = "srv_a";
const SRV_B = "srv_b";

/**
 * A server ENROLLED enough for the supervisor to dial. Reconcile skips any row
 * without an agent cert fingerprint, and `recordServerHealth`'s HAS_LIVE_AGENT
 * fence silently drops writes onto one — so a bare `seedServer` would make every
 * assertion below pass vacuously.
 */
async function seedEnrolledServer(id: string, createdAt: string): Promise<void> {
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
      cpuUsage: 1,
      memoryUsage: 1,
      diskUsage: 1,
      agentPort: 9443,
      agentCertFingerprint: `fp_${id}`,
      agentCertPem: "pem",
      agentVersion: "1.10.0",
      createdAt,
    })
    .onConflictDoNothing();
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // Every successful connect calls `resolveExpectedAgentVersion`, which reaches
  // for the GitHub releases API. Fail it closed so the suite never touches the
  // network — the caller already falls back to the compiled-in expected version.
  globalThis.fetch = (() =>
    Promise.reject(new Error("network disabled in tests"))) as typeof fetch;
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table apps, databases, monitoring_settings, servers, activities, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
  clearMetricsHistory();
  clearContainerHistory();
  __resetMonitoringSettingsMemo();
  delete process.env.DEPLO_MONITORING_FORCE_POLL;
});

afterEach(async () => {
  // Order matters. `stopMetricsStreams` flips `stopping` and aborts every loop
  // SYNCHRONOUSLY before it awaits them, so cutting the fake streams right after
  // it is called lets each `for await` finish and the loop see the stop flag. Cut
  // them first instead and the loops would treat it as a clean end and
  // immediately reconnect.
  const stopped = stopMetricsStreams();
  endAllFeeds();
  await stopped;
  __setMetricsConnectorForTest();
  delete process.env.DEPLO_MONITORING_FORCE_POLL;
});

/** Turn the instance-wide master switch OFF. A poll-mode loop then measures
 *  nothing, so a test can exercise the fallback without a socket to dial. */
async function disableSaving(): Promise<void> {
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

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

function hello(over: Partial<HelloResponse> = {}): HelloResponse {
  return {
    contractVersion: 1,
    agentVersion: "1.10.0",
    dockerAvailable: true,
    dockerVersion: "27",
    capabilities: ["metrics-stream", "container-stats"],
    traefikRunning: true,
    ...over,
  };
}

function containerStat(projectId: string, name: string, cpu: number): ContainerStat {
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
  };
}

function frame(containers: ContainerStat[] = []): MetricsSample {
  return {
    host: {
      cpu: 12,
      cpuCores: 4,
      memUsed: 1_000,
      memTotal: 4_000,
      memPct: 25,
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

/**
 * A hand-pumped `streamMetrics` generator.
 *
 * `send()` resolves only once the supervisor has finished handling that frame and
 * come back for the next one, which is what lets every assertion run at a
 * deterministic point in the loop rather than after an arbitrary sleep.
 */
const liveFeeds: Feed[] = [];

/**
 * Cut every open fake stream. Stands in for what closing a real gRPC channel
 * does to the iterator — without it the supervisor's shutdown would block
 * forever on a `for await` over a generator that is simply waiting for a frame
 * nobody will send.
 */
function endAllFeeds(): void {
  for (const f of liveFeeds.splice(0)) f.end();
}

class Feed {
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
      // Reached only when the consumer came back for the NEXT frame, i.e. the
      // loop body for the frame just yielded has fully completed.
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

  /** The transport went away: the iterator finishes rather than hanging. */
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

/**
 * Spin until `pred` holds. The per-server loops are started with `void`, so there
 * is no promise to await for "it got that far". Bounded by ITERATIONS, not by
 * `Date.now()` — one test below replaces the clock.
 */
async function waitFor(
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

async function statusCheckedAt(id: string): Promise<string | null> {
  const [row] = await db
    .select({ at: serversTable.statusCheckedAt })
    .from(serversTable)
    .where(eq(serversTable.id, id));
  return row?.at ?? null;
}

/* ------------------------------------------------------------------ */
/* Mode selection                                                      */
/* ------------------------------------------------------------------ */

test("a server with an enrolled agent runs in STREAM mode and its frames land in the buffers", async () => {
  await seedEnrolledServer(SRV_A, "2026-01-01T00:00:00.000Z");
  await seedApp(db, { id: "prj_1", slug: "app-one", serverId: SRV_A });

  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({ conn: feed.connection(), hello: hello() }));

  startMetricsStreams();
  await waitFor(() => __streamModes()[SRV_A] === "stream", "srv_a to enter stream mode");
  await feed.send(frame([containerStat("prj_1", "app-one-web-1", 7)]));

  assert.equal(__streamModes()[SRV_A], "stream");
  assert.equal(getMetricsHistory(SRV_A).length, 1, "the host half of the frame is buffered");
  assert.equal(getContainerHistory("prj_1").length, 1, "and the container half too");
});

test("a server whose agent predates the stream demotes to POLL alone — the fleet keeps streaming", async () => {
  // The degradation path is PER SERVER on purpose: a fleet is updated one host at
  // a time, so one old agent must never take its neighbours' telemetry with it.
  await disableSaving(); // the poll fallback then has nothing to dial
  await seedEnrolledServer(SRV_A, "2026-01-01T00:00:00.000Z");
  await seedEnrolledServer(SRV_B, "2026-01-01T00:00:01.000Z");

  const feed = new Feed();
  __setMetricsConnectorForTest(async (serverId: string) => {
    if (serverId === SRV_A) throw new AgentMetricsStreamUnsupportedError("too old");
    return { conn: feed.connection(), hello: hello() };
  });

  startMetricsStreams();
  await waitFor(() => __streamModes()[SRV_A] === "poll", "srv_a to demote to poll");
  assert.equal(
    __streamModes()[SRV_B],
    "stream",
    "the up-to-date host must be unaffected by its neighbour's agent version",
  );
});

test("DEPLO_MONITORING_FORCE_POLL=1 forces EVERY server to poll — the production kill switch", async () => {
  // This is the real revert for the streaming path. The agent binary is
  // forward-only (`resolveLatestAgentRelease` is always-latest, so
  // `updateServerAgent` structurally cannot downgrade), so if this env var does
  // not actually work there is no way back short of shipping a control-plane fix.
  await disableSaving();
  await seedEnrolledServer(SRV_A, "2026-01-01T00:00:00.000Z");
  await seedEnrolledServer(SRV_B, "2026-01-01T00:00:01.000Z");

  let dialled = 0;
  __setMetricsConnectorForTest(async () => {
    dialled++;
    throw new Error("the kill switch must not open a stream at all");
  });

  process.env.DEPLO_MONITORING_FORCE_POLL = "1";
  startMetricsStreams();
  await waitFor(
    () => Object.keys(__streamModes()).length === 2,
    "both servers to be picked up",
  );

  assert.deepEqual(__streamModes(), { [SRV_A]: "poll", [SRV_B]: "poll" });
  assert.equal(dialled, 0, "no stream connection may be opened while forced to poll");
});

/* ------------------------------------------------------------------ */
/* Demux                                                               */
/* ------------------------------------------------------------------ */

test("one host frame demuxes to the right App and Database by projectId", async () => {
  await seedEnrolledServer(SRV_A, "2026-01-01T00:00:00.000Z");
  await seedApp(db, { id: "prj_1", slug: "app-one", serverId: SRV_A });
  await seedDatabase(db, { id: "db_1", serverId: SRV_A });

  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({ conn: feed.connection(), hello: hello() }));
  startMetricsStreams();
  await waitFor(() => __streamModes()[SRV_A] === "stream", "srv_a to stream");

  await feed.send(
    frame([
      containerStat("prj_1", "app-one-web-1", 5),
      containerStat("prj_1", "app-one-worker-1", 3),
      containerStat("db_1", "db-db-1", 11),
    ]),
  );

  // The App's two containers fold into ONE series — the app TOTAL — rather than
  // two: splitting siblings apart by name is how a Compose app's chart lies.
  const app = getContainerHistory("prj_1");
  assert.equal(app.length, 1);
  assert.equal(app[0].cpu, 8);
  assert.equal(app[0].containers, 2);
  assert.deepEqual(
    latestContainerInstances("prj_1").map((i) => i.name),
    ["app-one-web-1", "app-one-worker-1"],
    "the per-container breakdown survives as its own live cell",
  );

  const database = getContainerHistory("db_1");
  assert.equal(database.length, 1);
  assert.equal(database[0].cpu, 11);
});

test("a container with an EMPTY projectId is ignored, never guessed at from its name", async () => {
  // The `deplo.project` label is the only identity we trust. An unlabelled
  // container is not ours to attribute, and inferring one from the name would
  // silently graft a foreign workload onto an App's chart.
  await seedEnrolledServer(SRV_A, "2026-01-01T00:00:00.000Z");
  await seedApp(db, { id: "prj_1", slug: "app-one", serverId: SRV_A });

  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({ conn: feed.connection(), hello: hello() }));
  startMetricsStreams();
  await waitFor(() => __streamModes()[SRV_A] === "stream", "srv_a to stream");

  await feed.send(
    frame([
      containerStat("", "prj_1-web-1", 99), // the NAME looks like it belongs to prj_1
      containerStat("", "some-unmanaged-thing", 50),
    ]),
  );

  assert.equal(getContainerHistory("prj_1").length, 0, "the name must not be a demux key");
  assert.equal(getContainerHistory("").length, 0, "and the empty id is not a bucket either");
  assert.deepEqual(latestContainerInstances("prj_1"), []);
  // The HOST half of the same frame is unaffected: one unattributable stat costs
  // one stat, never the frame.
  assert.equal(getMetricsHistory(SRV_A).length, 1);
});

test("the master switch gates HOST history only; container history keeps flowing", async () => {
  // The filter is applied on the RECORD side, never by declining to open the
  // stream: one stream carries both halves, so gating the transport would take
  // container history down as collateral.
  await disableSaving();
  await seedEnrolledServer(SRV_A, "2026-01-01T00:00:00.000Z");
  await seedApp(db, { id: "prj_1", slug: "app-one", serverId: SRV_A });

  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({ conn: feed.connection(), hello: hello() }));
  startMetricsStreams();
  await waitFor(() => __streamModes()[SRV_A] === "stream", "srv_a to stream");

  await feed.send(frame([containerStat("prj_1", "app-one-web-1", 4)]));

  assert.equal(getMetricsHistory(SRV_A).length, 0, "host history is off");
  assert.equal(getContainerHistory("prj_1").length, 1, "container history is not");
});

/* ------------------------------------------------------------------ */
/* Reconnect backoff                                                   */
/* ------------------------------------------------------------------ */

test("reconnect backoff grows exponentially and is CAPPED at RECONNECT_BACKOFF_CAP_MS", () => {
  const JITTER = 1.2; // +/-20%, so the band to assert against is base * [0.8, 1.2]

  for (let attempt = 0; attempt < 4; attempt++) {
    const base = Math.min(RECONNECT_BACKOFF_CAP_MS, 1000 * 2 ** attempt);
    const v = backoffFor(attempt);
    assert.ok(
      v >= Math.max(250, base * 0.8) && v <= base * JITTER,
      `backoffFor(${attempt}) = ${v} must sit within +/-20% of ${base}`,
    );
  }

  // Capped: no attempt, however deep, escalates past the ceiling. That ceiling
  // bounds how long a host that came back stays dark — and it is an INPUT to
  // GAP_MS (see chart-gaps.test.ts), so letting it grow would also start banding
  // "No data" across a perfectly healthy reconnect.
  for (const attempt of [10, 16, 64, 1024]) {
    const v = backoffFor(attempt);
    assert.ok(
      Number.isFinite(v) && v <= RECONNECT_BACKOFF_CAP_MS * JITTER,
      `backoffFor(${attempt}) = ${v} must not exceed the ${RECONNECT_BACKOFF_CAP_MS}ms cap`,
    );
  }
});

test("reconnect attempts are UNBOUNDED — a host down for an hour reconnects when it returns", async () => {
  // There is deliberately no give-up state: the supervisor must recover a host
  // with zero operator action, so a long outage costs only the (capped) backoff.
  await seedEnrolledServer(SRV_A, "2026-01-01T00:00:00.000Z");

  const held: { feed: Feed | null } = { feed: null };
  let attempts = 0;
  __setMetricsConnectorForTest(async () => {
    attempts++;
    if (attempts < 3) throw new Error("host is down");
    held.feed = new Feed();
    return { conn: held.feed.connection(), hello: hello() };
  });

  startMetricsStreams();
  // Two failures back off ~1s then ~2s (with jitter) before the host returns.
  await waitFor(() => attempts >= 3, "the third dial, after two failures", 600);
  await waitFor(() => held.feed !== null, "the recovered connection");
  await held.feed!.send(frame());
  assert.equal(
    getMetricsHistory(SRV_A).length,
    1,
    "telemetry resumes on its own once the host answers again",
  );
});

/* ------------------------------------------------------------------ */
/* The health heartbeat — the highest-risk coupling in this change     */
/* ------------------------------------------------------------------ */

test("HEALTH_WRITE_MS stays under the prober's 15s THROTTLE_MS, or the prober silently re-enables its fleet-wide dial fan-out", () => {
  // THROTTLE_MS in lib/data/server-health.ts is 15000 and is not exported; it is
  // restated here because this file is the only place the coupling is visible at
  // all. The prober SKIPS its own dial while `status_checked_at` still looks
  // fresh — so while the heartbeat stays under that window, a received frame
  // REPLACES a dial. The moment it exceeds it, the row goes stale between
  // heartbeats, the prober starts dialling every host every 15s again, and
  // NOTHING tells you: the charts still look perfect.
  const PROBER_THROTTLE_MS = 15_000;
  assert.ok(
    HEALTH_WRITE_MS < PROBER_THROTTLE_MS,
    `HEALTH_WRITE_MS (${HEALTH_WRITE_MS}) must stay under the prober's throttle (${PROBER_THROTTLE_MS})`,
  );

  // ...and that alone is NOT enough, which we learned the expensive way. The
  // assertion above passed while production wrote every 15 SECONDS.
  //
  // The heartbeat can only fire when a frame arrives, so its real period is a
  // MULTIPLE of the cadence, never HEALTH_WRITE_MS itself. At 10_000 with a 5s
  // cadence the second frame lands exactly ON the boundary: two frames 4999ms
  // apart sum to 9998, fail `>= 10_000`, and defer the write to the third frame.
  // Real period 15s — precisely the throttle. Observed on the live fleet at
  // 14:22:49 / 14:23:04 / 14:23:19 before this was fixed.
  //
  // So model the jitter and assert the EFFECTIVE period, not the constant.
  const EARLY_FRAME_TOLERANCE_MS = 100;
  const effectivePeriod =
    Math.ceil((HEALTH_WRITE_MS + EARLY_FRAME_TOLERANCE_MS) / STREAM_INTERVAL_MS) *
    STREAM_INTERVAL_MS;
  assert.ok(
    effectivePeriod < PROBER_THROTTLE_MS,
    `HEALTH_WRITE_MS (${HEALTH_WRITE_MS}) at a ${STREAM_INTERVAL_MS}ms cadence writes every ` +
      `${effectivePeriod}ms once a frame lands early — that must stay under ${PROBER_THROTTLE_MS}ms. ` +
      `Keep HEALTH_WRITE_MS strictly BETWEEN one and two cadences.`,
  );
});

test("health is written AT MOST once per 10s and AT LEAST once per 15s under a 5s frame rate", async () => {
  // Both bounds, for different reasons. The UPPER bound is the saving: a write
  // per frame would put the whole fleet's DB churn back on the 5s cadence. The
  // LOWER bound is the load-bearing half — it is what keeps the health prober
  // from re-enabling its own dial fan-out (see the test above).
  await seedEnrolledServer(SRV_A, "2026-01-01T00:00:00.000Z");

  // A controllable clock: the supervisor throttles off `Date.now()`, so
  // simulating 40s of a 5s stream is a matter of advancing it rather than of
  // waiting 40 seconds. It starts at the real now so these writes stay ordered
  // after the connect-time one — `recordServerHealth` fences on a monotonic
  // `status_checked_at` and would silently drop an out-of-order write.
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;

  try {
    const feed = new Feed();
    __setMetricsConnectorForTest(async () => ({ conn: feed.connection(), hello: hello() }));
    startMetricsStreams();
    // Wait for the CONNECT-time health write, not merely for the mode: that write
    // is where `lastHealthWriteAt` is seeded, so advancing the clock before it
    // lands would make the first interval non-deterministic.
    await waitFor(
      async () => (await statusCheckedAt(SRV_A)) !== null,
      "the opening health write",
    );

    const writes: number[] = [];
    let lastSeen = await statusCheckedAt(SRV_A);

    for (let i = 0; i < 8; i++) {
      clock += 5_000; // 8 frames x 5s = 40s of stream time
      await feed.send(frame());
      const at = await statusCheckedAt(SRV_A);
      if (at !== lastSeen) {
        lastSeen = at;
        writes.push(clock);
      }
    }

    // Pinned exactly, so neither bound below can pass vacuously: 40s of stream
    // at one write per 10s is 4, and 8 frames arrived to produce them.
    assert.equal(
      writes.length,
      4,
      "8 frames over 40s must yield exactly 4 heartbeats, not 8 and not 1",
    );

    // UPPER bound: never more often than every HEALTH_WRITE_MS.
    for (let i = 1; i < writes.length; i++) {
      const delta = writes[i] - writes[i - 1];
      assert.ok(
        delta >= HEALTH_WRITE_MS,
        `two health writes ${delta}ms apart — the ${HEALTH_WRITE_MS}ms throttle is not holding`,
      );
    }

    // LOWER bound: no stretch of the run longer than the prober's throttle
    // without a write, counting from the connect-time write and including the
    // tail after the last frame.
    const PROBER_THROTTLE_MS = 15_000;
    let previous = clock - 40_000; // the connect-time write
    for (const w of [...writes, clock]) {
      assert.ok(
        w - previous <= PROBER_THROTTLE_MS,
        `${w - previous}ms passed with no health write — the prober's throttle would lapse`,
      );
      previous = w;
    }
  } finally {
    Date.now = realNow;
  }
});
