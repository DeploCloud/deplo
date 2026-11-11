import { test } from "node:test";
import assert from "node:assert/strict";

import { seedApp } from "../../data/app-graph-test-helpers";
import {
  getContainerHistory,
  latestContainerInstances,
} from "../container-history";
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
  frame,
  hello,
  seedEnrolledServer,
  setupSupervisor,
  waitFor,
} from "./supervisor-test-helpers";

const h = setupSupervisor();

async function twoServers(): Promise<Record<string, Feed>> {
  const feeds: Record<string, Feed> = {
    [SRV_A]: new Feed(),
    [SRV_B]: new Feed(),
  };
  for (const id of [SRV_A, SRV_B])
    await seedEnrolledServer(h.db, id, "2026-01-01T00:00:00.000Z");
  await seedApp(h.db, { id: "prj_1", slug: "web", serverId: SRV_A });
  __setMetricsConnectorForTest(async (serverId) => ({
    conn: feeds[serverId].connection(),
    hello: hello(),
  }));
  startMetricsStreams();
  await waitFor(
    () => [SRV_A, SRV_B].every((id) => __streamModes()[id] === "stream"),
    "both servers to stream",
  );
  return feeds;
}

const pause = () => new Promise((r) => setTimeout(r, 300));

test("an App on two servers is one total, with each server's share and every container", async () => {
  const feeds = await twoServers();

  await feeds[SRV_A].send(frame([containerStat("prj_1", "deplo-web-1", 5)]));
  await feeds[SRV_B].send(frame([containerStat("prj_1", "deplo-web-1", 7)]));
  await pause();
  await feeds[SRV_A].send(frame([containerStat("prj_1", "deplo-web-1", 6)]));

  const total = getContainerHistory("prj_1").at(-1)!;
  assert.equal(total.cpu, 13);
  assert.equal(total.running, 2);
  assert.deepEqual(
    total.members?.map((m) => [m.serverId, m.cpu]),
    [
      [SRV_A, 6],
      [SRV_B, 7],
    ],
  );
  assert.deepEqual(
    latestContainerInstances("prj_1").map((i) => i.serverId),
    [SRV_A, SRV_B],
  );
});

test("a server that stopped running the App leaves its total with its next frame", async () => {
  const feeds = await twoServers();

  await feeds[SRV_A].send(frame([containerStat("prj_1", "deplo-web-1", 5)]));
  await feeds[SRV_B].send(frame([containerStat("prj_1", "deplo-web-1", 7)]));
  await feeds[SRV_A].send(frame([]));
  await pause();
  await feeds[SRV_B].send(frame([containerStat("prj_1", "deplo-web-1", 8)]));

  const last = getContainerHistory("prj_1").at(-1)!;
  assert.equal(last.cpu, 8);
  assert.deepEqual(
    last.members?.map((m) => m.serverId),
    [SRV_B],
  );
});
