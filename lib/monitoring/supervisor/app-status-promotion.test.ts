import { test } from "node:test";
import assert from "node:assert/strict";

import { seedApp } from "../../data/app-graph-test-helpers";
import { telemetrySaysRunning } from "../../data/app-status-reconcile";
import type { ContainerStat } from "../../agent/gen/agent";
import {
  __setMetricsConnectorForTest,
  __streamModes,
  startMetricsStreams,
} from "../supervisor";
import {
  Feed,
  SRV_A,
  appRow,
  containerStat,
  countPings,
  frame,
  hello,
  seedEnrolledServer,
  setupSupervisor,
  streamingServer,
  waitFor,
} from "./supervisor-test-helpers";

// The gap these pin: `apps.status` is INTENT (the last thing the control plane was ASKED to do), and it went stale silently.

const h = setupSupervisor();

test("a frame reporting a RUNNING container clears a stale `error` - the reboot incident", async () => {
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");
  await seedApp(h.db, {
    id: "prj_1",
    slug: "app-one",
    serverId: SRV_A,
    status: "error",
  });
  const before = await appRow(h.db, "prj_1");

  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({
    conn: feed.connection(),
    hello: hello(),
  }));
  const pings = countPings("prj_1");
  try {
    startMetricsStreams();
    await waitFor(() => __streamModes()[SRV_A] === "stream", "srv_a to stream");

    // ONE frame is enough: the reconcile clock is seeded to 0 on connect, so a host that came back corrects immediately.
    await feed.send(frame([containerStat("prj_1", "app-one-web-1", 7)]));

    const after = await appRow(h.db, "prj_1");
    assert.equal(
      after.status,
      "active",
      "a running container must refute a stored `error`",
    );
    assert.notEqual(
      after.updatedAt,
      before.updatedAt,
      "the correction is persisted, not folded at read time",
    );
    await waitFor(
      () => pings.count() >= 1,
      "an appChanged ping for the corrected App",
    );
  } finally {
    pings.stop();
  }
});

test("only `error` is ever promoted - active/idle/stopping/queued/building are left exactly as stored", async () => {
  // The write-war guard's allowlist is exactly ONE value wide: `stopping` is written before an up-to-60s
  // `docker stop`, so frames in that window still say "running" and promoting would bounce the user's Stop.
  const untouchable = [
    "active",
    "idle",
    "stopping",
    "queued",
    "building",
  ] as const;
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");
  for (const status of untouchable) {
    await seedApp(h.db, {
      id: `prj_${status}`,
      slug: status,
      serverId: SRV_A,
      status,
    });
  }
  const before = new Map(
    await Promise.all(
      untouchable.map(
        async (s) => [s, await appRow(h.db, `prj_${s}`)] as const,
      ),
    ),
  );

  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({
    conn: feed.connection(),
    hello: hello(),
  }));
  startMetricsStreams();
  await waitFor(() => __streamModes()[SRV_A] === "stream", "srv_a to stream");

  await feed.send(
    frame(untouchable.map((s) => containerStat(`prj_${s}`, `${s}-web-1`, 4))),
  );

  for (const status of untouchable) {
    const after = await appRow(h.db, `prj_${status}`);
    assert.equal(
      after.status,
      status,
      `\`${status}\` must not be rewritten by telemetry`,
    );
    assert.equal(
      after.updatedAt,
      before.get(status)!.updatedAt,
      `\`${status}\` must not even be WRITTEN (updated_at moved)`,
    );
  }
});

test("a crash-looping container is NOT promoted - `restarting` vetoes the whole App", async () => {
  // Promoting a restart loop only hands it to `displayStatus` to re-demote, flipping the badge through a state that was never true.
  const feed = await streamingServer(h.db);
  await seedApp(h.db, {
    id: "prj_loop",
    slug: "loop",
    serverId: SRV_A,
    status: "error",
  });

  await feed.send(
    frame([
      containerStat("prj_loop", "loop-web-1", 1, { state: "running" }),
      containerStat("prj_loop", "loop-worker-1", 0, {
        state: "restarting",
        running: false,
        restartCount: 47,
      }),
    ]),
  );

  assert.equal(
    (await appRow(h.db, "prj_loop")).status,
    "error",
    "one restarting sibling must veto the promotion of the whole stack",
  );
});

test("a container that exists but is EXITED does not promote", async () => {
  const feed = await streamingServer(h.db);
  await seedApp(h.db, {
    id: "prj_dead",
    slug: "dead",
    serverId: SRV_A,
    status: "error",
  });

  await feed.send(
    frame([
      containerStat("prj_dead", "dead-web-1", 0, {
        state: "exited",
        running: false,
      }),
    ]),
  );

  assert.equal((await appRow(h.db, "prj_dead")).status, "error");
});

test("telemetrySaysRunning: what counts as proof an App is up", () => {
  const c = (over: Partial<ContainerStat>) =>
    containerStat("prj_1", "x", 0, over);

  assert.equal(
    telemetrySaysRunning([]),
    false,
    "an empty bucket is not an answer",
  );
  assert.equal(telemetrySaysRunning([c({ state: "running" })]), true);
  assert.equal(
    telemetrySaysRunning([c({ state: "exited", running: false })]),
    false,
  );
  assert.equal(
    telemetrySaysRunning([c({ state: "created", running: false })]),
    false,
  );
  assert.equal(
    telemetrySaysRunning([
      c({ state: "running" }),
      c({ state: "restarting", running: false }),
    ]),
    false,
    "a restarting sibling vetoes the whole App",
  );
  assert.equal(
    telemetrySaysRunning([
      c({ state: "running" }),
      c({ state: "exited", running: false }),
    ]),
    true,
    "a partially-up stack is still up",
  );

  // An agent too old to send `state` leaves it "" (proto3 default), so the legacy boolean stays the fallback.
  assert.equal(telemetrySaysRunning([c({ state: "", running: true })]), true);
  assert.equal(telemetrySaysRunning([c({ state: "", running: false })]), false);
});
