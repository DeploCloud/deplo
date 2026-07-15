import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { cleanResourceLimits, updateAppResources } from "./apps";
import { loadAppGraph } from "./app-graph-load";

/**
 * Per-app resource limits: the pure validator (`cleanResourceLimits`) and the
 * team-scoped writer (`updateAppResources`). The writer round-trips through the
 * relational assembler (all-null ⇒ `resources: null`) and refuses a cross-team id.
 */

/* ---- cleanResourceLimits (pure) ------------------------------------- */

test("cleanResourceLimits: empty input ⇒ every dimension uncapped", () => {
  const r = cleanResourceLimits({});
  assert.equal(Object.values(r).every((v) => v === null), true);
});

test("cleanResourceLimits: a valid full set passes through", () => {
  const r = cleanResourceLimits({
    memoryMb: 1024,
    memoryReservationMb: 512,
    swapMb: 2048,
    cpuMilli: 1500,
    cpuShares: 1024,
    cpuset: "0-3",
    pidsLimit: 200,
    shmSizeMb: 64,
    storageGb: 20,
    nofile: 4096,
    nproc: 512,
    oomScoreAdj: -500,
  });
  assert.equal(r.memoryMb, 1024);
  assert.equal(r.cpuMilli, 1500);
  assert.equal(r.cpuset, "0-3");
  assert.equal(r.oomScoreAdj, -500);
});

test("cleanResourceLimits: rejects non-integers and out-of-range values", () => {
  assert.throws(() => cleanResourceLimits({ memoryMb: 12.5 }), /whole number/);
  assert.throws(() => cleanResourceLimits({ memoryMb: 3 }), /at least 6/);
  assert.throws(() => cleanResourceLimits({ cpuShares: 1 }), /at least 2/);
  assert.throws(() => cleanResourceLimits({ oomScoreAdj: 5000 }), /at most 1000/);
});

test("cleanResourceLimits: cross-field coherence (Docker's own rules)", () => {
  // reservation must not exceed the hard limit
  assert.throws(
    () => cleanResourceLimits({ memoryMb: 256, memoryReservationMb: 512 }),
    /reservation can't exceed/i,
  );
  // swap needs a memory limit, and must be ≥ it
  assert.throws(() => cleanResourceLimits({ swapMb: 512 }), /before a swap limit/i);
  assert.throws(
    () => cleanResourceLimits({ memoryMb: 1024, swapMb: 512 }),
    /at least the memory limit/i,
  );
  // a coherent memory+swap pair is fine
  const ok = cleanResourceLimits({ memoryMb: 512, swapMb: 1024 });
  assert.equal(ok.swapMb, 1024);
});

test("cleanResourceLimits: cpuset must be a core list", () => {
  assert.throws(() => cleanResourceLimits({ cpuset: "abc" }), /core list/);
  assert.equal(cleanResourceLimits({ cpuset: "0,2-3" }).cpuset, "0,2-3");
  // Blank/whitespace collapses to unset, not an error.
  assert.equal(cleanResourceLimits({ cpuset: "  " }).cpuset, null);
});

/* ---- updateAppResources (team-scoped writer) ------------------------ */

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
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("updateAppResources round-trips through the assembler", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(async () => {
    await updateAppResources("prj_1", {
      memoryMb: 512,
      cpuMilli: 500,
      pidsLimit: 100,
    });
  });
  const app = await loadAppGraph("prj_1");
  assert.equal(app?.resources?.memoryMb, 512);
  assert.equal(app?.resources?.cpuMilli, 500);
  assert.equal(app?.resources?.pidsLimit, 100);
  // Untouched dimensions stay uncapped.
  assert.equal(app?.resources?.storageGb, null);
});

test("clearing every field ⇒ resources assembles back to null", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(async () => {
    // First set a limit, then clear the whole set.
    await updateAppResources("prj_1", { memoryMb: 256 });
    assert.equal((await loadAppGraph("prj_1"))?.resources?.memoryMb, 256);
    await updateAppResources("prj_1", {});
  });
  const app = await loadAppGraph("prj_1");
  assert.equal(app?.resources, null);
});

test("updateAppResources refuses a cross-team app id", async () => {
  // App lives in TEAM_B; acting as a TEAM_A member must not reach it.
  await seedApp(db, { id: "prj_b", teamId: TEAM_B });
  await assert.rejects(
    asUser1(() => updateAppResources("prj_b", { memoryMb: 512 })),
    /not found/i,
  );
  // And the row is unchanged.
  const app = await loadAppGraph("prj_b");
  assert.equal(app?.resources, null);
});
