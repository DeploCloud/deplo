import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { envExampleKeys } from "../db/schema/control-plane/env-vars";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { addEnv } from "./env";
import {
  dismissEnvExampleKey,
  listEnvExampleKeys,
  pickEnvExample,
  planEnvExampleSync,
  syncEnvExample,
} from "./env-example";

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
    truncate table env_example_keys, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db);
  await seedServer(db);
  await seedApp(db, { id: "app_web", slug: "web", teamId: TEAM_A });
  await seedApp(db, { id: "app_other", slug: "other", teamId: TEAM_B });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const FILE = [
  "# --- Database ---",
  "# Postgres connection string.",
  "# Use the pooled URL in production.",
  "DATABASE_URL=",
  "AUTH_URL=http://localhost:3000",
  "SMTP_PORT=587",
].join("\n");

test("the first of .env.example, .env.sample, .env.template a repo has is the one read", () => {
  assert.equal(pickEnvExample([".env.template", ".env.sample"]), ".env.sample");
  assert.equal(pickEnvExample(["README.md", ".env"]), null);
});

test("the file decides what is added, refreshed and dropped", () => {
  const plan = planEnvExampleSync(
    [
      { key: "NEW", value: "" },
      { key: "KEPT", value: "1" },
      { key: "1BAD", value: "x" },
    ],
    ["KEPT", "GONE"],
  );
  assert.deepEqual(
    plan.insert.map((e) => e.key),
    ["NEW"],
  );
  assert.deepEqual(
    plan.update.map((e) => e.key),
    ["KEPT"],
  );
  assert.deepEqual(plan.remove, ["GONE"]);
});

test("each name lands with its note and its example as a suggestion", async () => {
  assert.equal(await syncEnvExample("app_web", FILE), 3);
  const keys = await asUser1(() => listEnvExampleKeys("app_web"));
  assert.deepEqual(
    keys.map((k) => [k.key, k.note, k.example]),
    [
      ["AUTH_URL", null, "http://localhost:3000"],
      [
        "DATABASE_URL",
        "Postgres connection string.\nUse the pooled URL in production.",
        null,
      ],
      ["SMTP_PORT", null, "587"],
    ],
  );
});

test("a name with a variable already set is not asked for, and stops being once one is", async () => {
  await asUser1(() => addEnv("app_web", [{ key: "SMTP_PORT", value: "2525" }]));
  assert.equal(await syncEnvExample("app_web", FILE), 2);
  await asUser1(() =>
    addEnv("app_web", [{ key: "DATABASE_URL", value: "postgres://db" }]),
  );
  const keys = await asUser1(() => listEnvExampleKeys("app_web"));
  assert.deepEqual(
    keys.map((k) => k.key),
    ["AUTH_URL"],
  );
});

test("reading the file again adds nothing twice, and a dropped name goes", async () => {
  await syncEnvExample("app_web", FILE);
  assert.equal(await syncEnvExample("app_web", FILE), 0);
  await syncEnvExample(
    "app_web",
    "DATABASE_URL=\n# Now with a note\nSMTP_PORT=",
  );
  const keys = await asUser1(() => listEnvExampleKeys("app_web"));
  assert.deepEqual(
    keys.map((k) => [k.key, k.note]),
    [
      ["DATABASE_URL", null],
      ["SMTP_PORT", "Now with a note"],
    ],
  );
});

test("a dismissed name stays hidden until the file drops it and lists it again", async () => {
  await syncEnvExample("app_web", FILE);
  const [first] = await asUser1(() => listEnvExampleKeys("app_web"));
  await asUser1(() => dismissEnvExampleKey(first.id));
  await syncEnvExample("app_web", FILE);
  let keys = await asUser1(() => listEnvExampleKeys("app_web"));
  assert.ok(!keys.some((k) => k.key === first.key));
  await syncEnvExample("app_web", "DATABASE_URL=\nSMTP_PORT=");
  assert.equal(await syncEnvExample("app_web", FILE), 1);
  keys = await asUser1(() => listEnvExampleKeys("app_web"));
  assert.ok(keys.some((k) => k.key === first.key));
});

test("another team's app lists nothing and dismisses nothing", async () => {
  await syncEnvExample("app_other", FILE);
  assert.deepEqual(await asUser1(() => listEnvExampleKeys("app_other")), []);
  const [row] = await db
    .select({ id: envExampleKeys.id })
    .from(envExampleKeys)
    .where(eq(envExampleKeys.appId, "app_other"));
  await assert.rejects(() => asUser1(() => dismissEnvExampleKey(row.id)));
});
