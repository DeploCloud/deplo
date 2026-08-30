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
import { updateAppHealthCheck } from "./apps";
import { loadAppGraph } from "./app-graph-load";
import type { HealthCheck } from "../types";

/**
 * The team-scoped writer for an app's health check: it round-trips through the
 * assembler (off ⇒ `healthCheck: null`), refuses a cross-team id, and refuses a
 * compose stack outright.
 */

const CHECK: HealthCheck = {
  type: "http",
  path: "/healthz",
  port: 8080,
  command: null,
  intervalS: 15,
  timeoutS: 3,
  retries: 2,
  startPeriodS: 20,
};

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

test("an app starts with no health check", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  assert.equal((await loadAppGraph("prj_1"))?.healthCheck, null);
});

test("a saved check round-trips through the assembler", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(() => updateAppHealthCheck("prj_1", CHECK));
  assert.deepEqual((await loadAppGraph("prj_1"))?.healthCheck, CHECK);
});

test("turning it off puts it back to nothing, not to a disabled check", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(() => updateAppHealthCheck("prj_1", CHECK));
  await asUser1(() => updateAppHealthCheck("prj_1", null));
  assert.equal((await loadAppGraph("prj_1"))?.healthCheck, null);
});

test("a command check keeps its command and drops the http fields", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(() =>
    updateAppHealthCheck("prj_1", {
      ...CHECK,
      type: "command",
      path: null,
      port: null,
      command: "pg_isready -U app",
    }),
  );
  const h = (await loadAppGraph("prj_1"))?.healthCheck;
  assert.equal(h?.type, "command");
  assert.equal(h?.command, "pg_isready -U app");
  assert.equal(h?.path, null);
});

// The YAML is its author's. A `healthcheck:` written there is the one that runs,
// and a second one from Deplo would be a silent override.
test("a compose stack is refused", async () => {
  await seedApp(db, { id: "prj_2", teamId: TEAM_A, source: "compose" });
  await assert.rejects(
    asUser1(() => updateAppHealthCheck("prj_2", CHECK)),
    /own compose file/,
  );
});

test("a check that cannot pass is refused before it is saved", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await assert.rejects(
    asUser1(() =>
      updateAppHealthCheck("prj_1", { ...CHECK, type: "command", command: "" }),
    ),
    /Give the command/,
  );
  assert.equal((await loadAppGraph("prj_1"))?.healthCheck, null);
});

test("another team's app is not found", async () => {
  await seedApp(db, { id: "prj_3", teamId: TEAM_B });
  await assert.rejects(asUser1(() => updateAppHealthCheck("prj_3", CHECK)));
  assert.equal((await loadAppGraph("prj_3"))?.healthCheck, null);
});
