import { test } from "node:test";
import assert from "node:assert/strict";

import { seedApp } from "../../data/app-graph-test-helpers";
import { seedDatabase } from "../../data/backup-test-helpers";
import { getMetricsHistory } from "../history";
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
  containerStat,
  disableSaving,
  frame,
  hello,
  seedEnrolledServer,
  setupSupervisor,
  waitFor,
} from "./supervisor-test-helpers";

const h = setupSupervisor();

test("one host frame demuxes to the right App and Database by projectId", async () => {
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");
  await seedApp(h.db, { id: "prj_1", slug: "app-one", serverId: SRV_A });
  await seedDatabase(h.db, { id: "db_1", serverId: SRV_A });

  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({
    conn: feed.connection(),
    hello: hello(),
  }));
  startMetricsStreams();
  await waitFor(() => __streamModes()[SRV_A] === "stream", "srv_a to stream");

  await feed.send(
    frame([
      containerStat("prj_1", "app-one-web-1", 5),
      containerStat("prj_1", "app-one-worker-1", 3),
      containerStat("db_1", "db-db-1", 11),
    ]),
  );

  // The App's two containers fold into ONE series, the app TOTAL: splitting siblings by name makes the chart lie.
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
  // The `deplo.project` label is the only identity we trust: a name-inferred id grafts a foreign workload onto a chart.
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");
  await seedApp(h.db, { id: "prj_1", slug: "app-one", serverId: SRV_A });

  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({
    conn: feed.connection(),
    hello: hello(),
  }));
  startMetricsStreams();
  await waitFor(() => __streamModes()[SRV_A] === "stream", "srv_a to stream");

  await feed.send(
    frame([
      containerStat("", "prj_1-web-1", 99), // the NAME looks like it belongs to prj_1
      containerStat("", "some-unmanaged-thing", 50),
    ]),
  );

  assert.equal(
    getContainerHistory("prj_1").length,
    0,
    "the name must not be a demux key",
  );
  assert.equal(
    getContainerHistory("").length,
    0,
    "and the empty id is not a bucket either",
  );
  assert.deepEqual(latestContainerInstances("prj_1"), []);
  // The HOST half of the same frame is unaffected: one unattributable stat costs one stat, never the frame.
  assert.equal(getMetricsHistory(SRV_A).length, 1);
});

test("the master switch gates HOST history only; container history keeps flowing", async () => {
  // Filtered on the RECORD side: one stream carries both halves, so gating the transport would take container history too.
  await disableSaving(h.db);
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");
  await seedApp(h.db, { id: "prj_1", slug: "app-one", serverId: SRV_A });

  const feed = new Feed();
  __setMetricsConnectorForTest(async () => ({
    conn: feed.connection(),
    hello: hello(),
  }));
  startMetricsStreams();
  await waitFor(() => __streamModes()[SRV_A] === "stream", "srv_a to stream");

  await feed.send(frame([containerStat("prj_1", "app-one-web-1", 4)]));

  assert.equal(getMetricsHistory(SRV_A).length, 0, "host history is off");
  assert.equal(
    getContainerHistory("prj_1").length,
    1,
    "container history is not",
  );
});
