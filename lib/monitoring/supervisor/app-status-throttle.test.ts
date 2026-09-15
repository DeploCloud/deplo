import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { seedApp } from "../../data/app-graph-test-helpers";
import { APP_STATUS_RECONCILE_MS, STREAM_INTERVAL_MS } from "../supervisor";
import {
  SRV_A,
  appRow,
  containerStat,
  countPings,
  frame,
  setupSupervisor,
  streamingServer,
  waitFor,
} from "./supervisor-test-helpers";

const h = setupSupervisor();

test("NOTHING is written when nothing changed - across many frames and many reconcile windows", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;

  const pings = countPings("prj_ok");
  try {
    const feed = await streamingServer(h.db);
    await seedApp(h.db, {
      id: "prj_ok",
      slug: "ok",
      serverId: SRV_A,
      status: "active",
    });
    const before = await appRow(h.db, "prj_ok");

    for (let i = 0; i < 6; i++) {
      clock += APP_STATUS_RECONCILE_MS;
      await feed.send(frame([containerStat("prj_ok", "ok-web-1", 5)]));
    }

    const after = await appRow(h.db, "prj_ok");
    assert.equal(after.status, "active");
    assert.equal(
      after.updatedAt,
      before.updatedAt,
      "6 reconcile windows over an already-correct App must not write the row once",
    );
    assert.equal(pings.count(), 0, "and must not publish a single SSE ping");
  } finally {
    pings.stop();
    Date.now = realNow;
  }
});

test("a corrected App is written and published EXACTLY once, not once per frame", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;

  const pings = countPings("prj_1");
  try {
    const feed = await streamingServer(h.db);
    await seedApp(h.db, {
      id: "prj_1",
      slug: "app-one",
      serverId: SRV_A,
      status: "error",
    });

    await feed.send(frame([containerStat("prj_1", "app-one-web-1", 5)]));
    const corrected = await appRow(h.db, "prj_1");
    assert.equal(corrected.status, "active");
    await waitFor(
      () => pings.count() === 1,
      "exactly one ping for the correction",
    );

    for (let i = 0; i < 5; i++) {
      clock += APP_STATUS_RECONCILE_MS;
      await feed.send(frame([containerStat("prj_1", "app-one-web-1", 5)]));
    }

    const after = await appRow(h.db, "prj_1");
    assert.equal(
      after.updatedAt,
      corrected.updatedAt,
      "the correction is idempotent - re-observing a healthy App writes nothing",
    );
    assert.equal(pings.count(), 1, "and publishes nothing further");
  } finally {
    pings.stop();
    Date.now = realNow;
  }
});

test("the reconcile runs on its OWN clock, not the frame's", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;

  try {
    const feed = await streamingServer(h.db);
    await seedApp(h.db, {
      id: "prj_1",
      slug: "app-one",
      serverId: SRV_A,
      status: "active",
    });

    await feed.send(frame([containerStat("prj_1", "app-one-web-1", 5)]));

    await h.db
      .update(appsTable)
      .set({ status: "error" })
      .where(eq(appsTable.id, "prj_1"));

    clock += STREAM_INTERVAL_MS;
    await feed.send(frame([containerStat("prj_1", "app-one-web-1", 5)]));
    assert.equal(
      (await appRow(h.db, "prj_1")).status,
      "error",
      "a frame inside the throttle window must not run the statement",
    );

    clock += APP_STATUS_RECONCILE_MS;
    await feed.send(frame([containerStat("prj_1", "app-one-web-1", 5)]));
    assert.equal(
      (await appRow(h.db, "prj_1")).status,
      "active",
      "and the first frame past it must",
    );
  } finally {
    Date.now = realNow;
  }
});

test("APP_STATUS_RECONCILE_MS is slower than the frame cadence but still self-heals promptly", () => {
  assert.ok(
    APP_STATUS_RECONCILE_MS > STREAM_INTERVAL_MS,
    "the reconcile must not run at the frame cadence",
  );
  assert.ok(
    APP_STATUS_RECONCILE_MS <= 60_000,
    "a stale red badge must not outlive a minute",
  );
});
