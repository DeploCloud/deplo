import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { seedApp, seedDeployment } from "../../data/app-graph-test-helpers";
import { seedDatabase } from "../../data/backup-test-helpers";
import { getContainerHistory } from "../container-history";
import {
  SRV_A,
  SRV_B,
  appRow,
  containerStat,
  frame,
  seedEnrolledServer,
  setupSupervisor,
  streamingServer,
} from "./supervisor-test-helpers";

const h = setupSupervisor();

test("an App with a deployment in flight is NOT touched, even from `error`", async () => {
  const feed = await streamingServer(h.db);
  await seedApp(h.db, {
    id: "prj_q",
    slug: "queued-one",
    serverId: SRV_A,
    status: "error",
  });
  await seedApp(h.db, {
    id: "prj_b",
    slug: "building-one",
    serverId: SRV_A,
    status: "error",
  });
  await seedDeployment(h.db, {
    id: "dpl_q",
    appId: "prj_q",
    status: "queued",
  });
  await seedDeployment(h.db, {
    id: "dpl_b",
    appId: "prj_b",
    status: "building",
  });
  const beforeQ = await appRow(h.db, "prj_q");
  const beforeB = await appRow(h.db, "prj_b");

  await feed.send(
    frame([
      containerStat("prj_q", "queued-one-web-1", 3),
      containerStat("prj_b", "building-one-web-1", 3),
    ]),
  );

  const afterQ = await appRow(h.db, "prj_q");
  const afterB = await appRow(h.db, "prj_b");
  assert.equal(
    afterQ.status,
    "error",
    "a queued deployment owns this App's status",
  );
  assert.equal(afterB.status, "error", "so does a building one");
  assert.equal(afterQ.updatedAt, beforeQ.updatedAt);
  assert.equal(afterB.updatedAt, beforeB.updatedAt);
});

test("an App ABSENT from the frame is never written - absence is unknown, not failure", async () => {
  const feed = await streamingServer(h.db);
  await seedApp(h.db, {
    id: "prj_seen",
    slug: "seen",
    serverId: SRV_A,
    status: "error",
  });
  await seedApp(h.db, {
    id: "prj_absent",
    slug: "absent",
    serverId: SRV_A,
    status: "error",
  });
  const before = await appRow(h.db, "prj_absent");

  await feed.send(frame([containerStat("prj_seen", "seen-web-1", 5)]));

  assert.equal(
    (await appRow(h.db, "prj_seen")).status,
    "active",
    "the reconcile did run",
  );
  const after = await appRow(h.db, "prj_absent");
  assert.equal(
    after.status,
    "error",
    "an App nothing reported on must be left alone",
  );
  assert.equal(
    after.updatedAt,
    before.updatedAt,
    "and must not be written at all",
  );
});

test("an empty frame writes nothing - a host with no containers is not a host of failed Apps", async () => {
  const feed = await streamingServer(h.db);
  await seedApp(h.db, {
    id: "prj_1",
    slug: "app-one",
    serverId: SRV_A,
    status: "error",
  });
  const before = await appRow(h.db, "prj_1");

  await feed.send(frame([]));

  const after = await appRow(h.db, "prj_1");
  assert.equal(after.status, "error");
  assert.equal(after.updatedAt, before.updatedAt);
});

test("an App mid server-MOVE is skipped - the old host's containers are not evidence", async () => {
  const feed = await streamingServer(h.db);
  await seedEnrolledServer(h.db, SRV_B, "2026-01-01T00:00:01.000Z");
  await seedApp(h.db, {
    id: "prj_mv",
    slug: "moving",
    serverId: SRV_A,
    status: "error",
  });
  await h.db
    .update(appsTable)
    .set({ migrateFromServerId: SRV_B })
    .where(eq(appsTable.id, "prj_mv"));
  const before = await appRow(h.db, "prj_mv");

  await feed.send(frame([containerStat("prj_mv", "moving-web-1", 6)]));

  const after = await appRow(h.db, "prj_mv");
  assert.equal(
    after.status,
    "error",
    "a pending migration marker suspends the reconcile",
  );
  assert.equal(after.updatedAt, before.updatedAt);
});

test("a frame is only authority over the Apps ITS OWN host runs", async () => {
  const feed = await streamingServer(h.db, SRV_A);
  await seedEnrolledServer(h.db, SRV_B, "2026-01-01T00:00:01.000Z");
  await seedApp(h.db, {
    id: "prj_elsewhere",
    slug: "elsewhere",
    serverId: SRV_B,
    status: "error",
  });
  const before = await appRow(h.db, "prj_elsewhere");

  await feed.send(
    frame([containerStat("prj_elsewhere", "elsewhere-web-1", 9)]),
  );

  const after = await appRow(h.db, "prj_elsewhere");
  assert.equal(after.status, "error");
  assert.equal(after.updatedAt, before.updatedAt);
});

test("a Database id in the frame never touches an App, and is not an error either", async () => {
  const feed = await streamingServer(h.db);
  await seedDatabase(h.db, { id: "db_1", serverId: SRV_A });
  await seedApp(h.db, {
    id: "prj_1",
    slug: "app-one",
    serverId: SRV_A,
    status: "error",
  });

  await feed.send(
    frame([
      containerStat("db_1", "db-db-1", 2),
      containerStat("prj_1", "app-one-web-1", 2),
    ]),
  );

  assert.equal((await appRow(h.db, "prj_1")).status, "active");
  assert.equal(
    getContainerHistory("db_1").length,
    1,
    "the database still buffers metrics",
  );
});
