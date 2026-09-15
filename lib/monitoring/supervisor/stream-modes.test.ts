import { test } from "node:test";
import assert from "node:assert/strict";

import { seedApp } from "../../data/app-graph-test-helpers";
import { AgentMetricsStreamUnsupportedError } from "../../infra/agent-client/errors";
import { getMetricsHistory } from "../history";
import { getContainerHistory } from "../container-history";
import {
  __setMetricsConnectorForTest,
  __streamModes,
  startMetricsStreams,
} from "../supervisor";
import {
  Feed,
  SRV_A,
  SRV_B,
  containerStat,
  disableSaving,
  frame,
  hello,
  seedEnrolledServer,
  setupSupervisor,
  waitFor,
} from "./supervisor-test-helpers";

const h = setupSupervisor();

test("a server with an enrolled agent runs in STREAM mode and its frames land in the buffers", async () => {
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");
  await seedApp(h.db, { id: "prj_1", slug: "app-one", serverId: SRV_A });

  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({
    conn: feed.connection(),
    hello: hello(),
  }));

  startMetricsStreams();
  await waitFor(
    () => __streamModes()[SRV_A] === "stream",
    "srv_a to enter stream mode",
  );
  await feed.send(frame([containerStat("prj_1", "app-one-web-1", 7)]));

  assert.equal(__streamModes()[SRV_A], "stream");
  assert.equal(
    getMetricsHistory(SRV_A).length,
    1,
    "the host half of the frame is buffered",
  );
  assert.equal(
    getContainerHistory("prj_1").length,
    1,
    "and the container half too",
  );
});

test("a server whose agent predates the stream demotes to POLL alone - the fleet keeps streaming", async () => {
  await disableSaving(h.db);
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");
  await seedEnrolledServer(h.db, SRV_B, "2026-01-01T00:00:01.000Z");

  const feed = new Feed();
  __setMetricsConnectorForTest(async (serverId: string) => {
    if (serverId === SRV_A)
      throw new AgentMetricsStreamUnsupportedError("too old");
    return { conn: feed.connection(), hello: hello() };
  });

  startMetricsStreams();
  await waitFor(
    () => __streamModes()[SRV_A] === "poll",
    "srv_a to demote to poll",
  );
  assert.equal(
    __streamModes()[SRV_B],
    "stream",
    "the up-to-date host must be unaffected by its neighbour's agent version",
  );
});

test("DEPLO_MONITORING_FORCE_POLL=1 forces EVERY server to poll - the production kill switch", async () => {
  await disableSaving(h.db);
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");
  await seedEnrolledServer(h.db, SRV_B, "2026-01-01T00:00:01.000Z");

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
  assert.equal(
    dialled,
    0,
    "no stream connection may be opened while forced to poll",
  );
});
