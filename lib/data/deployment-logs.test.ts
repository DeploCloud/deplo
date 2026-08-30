import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { asc, count, eq } from "drizzle-orm";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-logs-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { deploymentLogs } from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  appendLog,
  clearDeploymentLogs,
  finalizeDeploymentLogs,
  loadDeploymentLogs,
  __setLogCapsForTest,
  __resetLogCapsForTest,
  __resetDeploymentLogBuffers,
} from "./deployment-logs";
import type { LogLine } from "../types";

/**
 * Step 4 buffered deployment_logs writer tests (relational-store PLAN §6 Decision
 * 18): the guaranteed final flush, line order preserved (Array.push order via the
 * id identity), the buffer-fills immediate flush, and drain-then-DELETE with the
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  __resetDeploymentLogBuffers();
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", status: "building" });
  await seedDeployment(db, { id: "dpl_1", appId: "prj_1", status: "building" });
});

const line = (text: string): LogLine => ({
  ts: "2026-01-01T00:00:00.000Z",
  level: "info",
  text,
});

test("final flush persists every enqueued line, in order", async () => {
  appendLog("dpl_1", line("one"));
  appendLog("dpl_1", line("two"));
  appendLog("dpl_1", line("three"));
  await finalizeDeploymentLogs("dpl_1");

  const rows = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, "dpl_1"))
    .orderBy(asc(deploymentLogs.id));
  assert.deepEqual(
    rows.map((r) => r.text),
    ["one", "two", "three"],
  );
});

test("loadDeploymentLogs flushes pending lines then reads them back", async () => {
  appendLog("dpl_1", line("a"));
  appendLog("dpl_1", line("b"));
  // No explicit finalize - loadDeploymentLogs must flush first.
  const logs = await loadDeploymentLogs("dpl_1");
  assert.deepEqual(
    logs.map((l) => l.text),
    ["a", "b"],
  );
});

test("a buffer that fills flushes immediately (no waiting for the timer)", async () => {
  // MAX_BUFFER is 200; push past it and the writer flushes without finalize.
  for (let i = 0; i < 250; i++) appendLog("dpl_1", line(`L${i}`));
  // Give the immediate flush its microtask/await turn.
  await finalizeDeploymentLogs("dpl_1");
  assert.equal(
    (await db.select({ n: count() }).from(deploymentLogs))[0]!.n,
    250,
  );
});

test("clear drains-then-DELETEs and a late flush can't resurrect cleared lines", async () => {
  appendLog("dpl_1", line("old-1"));
  appendLog("dpl_1", line("old-2"));
  await finalizeDeploymentLogs("dpl_1");
  assert.equal((await db.select({ n: count() }).from(deploymentLogs))[0]!.n, 2);

  // Enqueue more, then CLEAR before they flush - the clear bumps the epoch so the
  // buffered batch is dropped and the persisted rows are deleted.
  appendLog("dpl_1", line("doomed-1"));
  appendLog("dpl_1", line("doomed-2"));
  await clearDeploymentLogs("dpl_1");

  // A late finalize must NOT resurrect the cleared lines.
  await finalizeDeploymentLogs("dpl_1");
  assert.equal(
    (await db.select({ n: count() }).from(deploymentLogs))[0]!.n,
    0,
    "cleared deployment has no resurrected lines",
  );

  // A fresh build can append again from an empty stream.
  appendLog("dpl_1", line("new-1"));
  await finalizeDeploymentLogs("dpl_1");
  const rows = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, "dpl_1"));
  assert.deepEqual(
    rows.map((r) => r.text),
    ["new-1"],
  );
});

test("flushes for different deployments don't interleave", async () => {
  await seedDeployment(db, { id: "dpl_2", appId: "prj_1", status: "building" });
  appendLog("dpl_1", line("a1"));
  appendLog("dpl_2", line("b1"));
  appendLog("dpl_1", line("a2"));
  await Promise.all([
    finalizeDeploymentLogs("dpl_1"),
    finalizeDeploymentLogs("dpl_2"),
  ]);
  const one = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, "dpl_1"))
    .orderBy(asc(deploymentLogs.id));
  const two = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, "dpl_2"))
    .orderBy(asc(deploymentLogs.id));
  assert.deepEqual(
    one.map((r) => r.text),
    ["a1", "a2"],
  );
  assert.deepEqual(
    two.map((r) => r.text),
    ["b1"],
  );
});

test("a failed flush retries IN ORDER (no inversion across two failed batches)", async () => {
  // Regression: an earlier drain-and-unshift-on-failure inverted order - two batches
  // flushed in the same turn where both inserts fail would re-queue the SECOND batch
  // in front of the first (B…, A…).
  const fail = { n: 2 }; // fail exactly the first two flush inserts
  const real = db as unknown as {
    insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> };
  };
  const failing = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop === "insert") {
        return (table: unknown) =>
          fail.n > 0
            ? {
                values: () => {
                  fail.n--;
                  return Promise.reject(new Error("simulated flush failure"));
                },
              }
            : real.insert(table);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  __setTestDb(failing);
  try {
    // Two synchronous bursts each crossing MAX_BUFFER (200) in the SAME turn:
    // batch A then batch B, both scheduled before either flush callback runs.
    for (let i = 0; i < 200; i++) appendLog("dpl_1", line(`A${i}`));
    for (let i = 0; i < 200; i++) appendLog("dpl_1", line(`B${i}`));
    // Drain across the two failures + the eventual success.
    await finalizeDeploymentLogs("dpl_1");
    await finalizeDeploymentLogs("dpl_1");
    await finalizeDeploymentLogs("dpl_1");
    assert.equal(fail.n, 0, "both simulated failures were consumed");
  } finally {
    __setTestDb(db); // restore the real client for the rest of the suite
  }
  const rows = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, "dpl_1"))
    .orderBy(asc(deploymentLogs.id));
  const expected = [
    ...Array.from({ length: 200 }, (_, i) => `A${i}`),
    ...Array.from({ length: 200 }, (_, i) => `B${i}`),
  ];
  assert.deepEqual(
    rows.map((r) => r.text),
    expected,
    "enqueue order preserved across retries",
  );
});

/**
 * `deployment_logs` lives in the CONTROL PLANE's database, shared by every team,
 * but the build's output is the tenant's to write, and nothing prunes these rows.
 */
test("the per-line and per-deployment log caps hold, and a read can't reset the budget", async () => {
  await seedDeployment(db, {
    id: "dpl_cap",
    appId: "prj_1",
    status: "building",
  });
  __setLogCapsForTest(5, 20);
  try {
    // Per line: the HEAD is kept (that's where a compiler error is) and marked.
    appendLog("dpl_cap", line("y".repeat(100)));
    for (let i = 0; i < 10; i++) appendLog("dpl_cap", line(`L${i}`));
    let rows = await loadDeploymentLogs("dpl_cap");
    assert.equal(rows.length, 5, "exactly the ceiling is stored");
    assert.ok(rows[0].text.startsWith("yyyy") && rows[0].text.length < 100);
    assert.match(rows[0].text, /line truncated/);
    assert.match(rows[rows.length - 1].text, /log truncated at 5 lines/);

    // A reader opening the Logs page mid-build finalizes + EVICTS the buffer. The
    // budget must not live on that buffer, or the ceiling would reset per read.
    for (let i = 0; i < 5; i++) appendLog("dpl_cap", line(`B${i}`));
    rows = await loadDeploymentLogs("dpl_cap");
    assert.equal(rows.length, 5, "the ceiling survived the read");
    assert.ok(!rows.some((r) => r.text.startsWith("B")));

    // Clearing (a rebuild of the same deployment) starts a fresh budget.
    await clearDeploymentLogs("dpl_cap");
    appendLog("dpl_cap", line("fresh"));
    assert.deepEqual(
      (await loadDeploymentLogs("dpl_cap")).map((r) => r.text),
      ["fresh"],
    );
  } finally {
    __resetLogCapsForTest();
  }
});

test("an unstated build line is classified on read; an authored level is not", async () => {
  // The agent stamps the builder's whole output `info`, so the level that
  // matters is the one the line's TEXT states. Deplo's own sink lines already
  // carry a level and must survive untouched.
  appendLog(
    "dpl_1",
    line('#14 4.914 error: script "build" exited with code 1'),
  );
  appendLog("dpl_1", line("#14 DONE 4.9s"));
  appendLog("dpl_1", {
    ts: "2026-01-01T00:00:00.000Z",
    level: "command",
    text: "docker compose up -d",
  });
  appendLog("dpl_1", {
    ts: "2026-01-01T00:00:00.000Z",
    // A line the producer DID call info, whose text a keyword scanner would
    // have painted: it stays neutral, because nothing states a level.
    level: "info",
    text: "no errors found",
  });

  const logs = await loadDeploymentLogs("dpl_1");
  assert.deepEqual(
    logs.map((l) => l.level),
    ["error", "info", "command", "info"],
  );
  // The stored rows keep what the producer said - the reading is on the way out.
  const rows = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, "dpl_1"))
    .orderBy(asc(deploymentLogs.id));
  assert.equal(rows[0]!.level, "info");
});
