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
import { encryptSecret } from "../crypto";
import {
  appPreviewEnvVars as previewVarsTable,
  envVarTargets as envVarTargetsTable,
  envVars as envVarsTable,
} from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { appEnv } from "./build";

/**
 * A fork's code is a stranger's (ADR-0017 §7): its preview gets the preview-only
 * overrides and nothing the app itself was given, whatever the variable's type.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const APP = "prj_1";

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
    truncate table env_var_targets, env_vars, app_preview_env_vars, users, teams restart identity cascade;`);
  await seedIdentity(db);
  await seedServer(db);
  await seedApp(db, { id: APP });
  await db.insert(envVarsTable).values([
    {
      id: "env_1",
      appId: APP,
      key: "DATABASE_URL",
      valueEnc: encryptSecret("postgres://prod"),
      type: "plain",
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "env_2",
      appId: APP,
      key: "API_KEY",
      valueEnc: encryptSecret("sk-live"),
      type: "secret",
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await db
    .insert(envVarTargetsTable)
    .values(
      ["env_1", "env_2"].flatMap((envVarId) =>
        ["production", "preview"].map((target) => ({ envVarId, target })),
      ),
    );
  await db.insert(previewVarsTable).values([
    {
      id: "penv_1",
      appId: APP,
      key: "FLAG",
      valueEnc: encryptSecret("preview"),
      type: "plain",
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "penv_2",
      appId: APP,
      key: "PREVIEW_TOKEN",
      valueEnc: encryptSecret("shh"),
      type: "secret",
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
});

const preview = (isFork: boolean) => ({
  host: "blog-pr-1.example",
  url: "https://blog-pr-1.example",
  branch: "feat",
  prNumber: 1,
  isFork,
});

test("a fork preview gets only the plain preview overrides", async () => {
  const env = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    appEnv(APP, "preview", { preview: preview(true) }),
  );
  assert.equal(env.FLAG, "preview");
  assert.equal(
    env.DATABASE_URL,
    undefined,
    "a plain app value is still the app's",
  );
  assert.equal(env.API_KEY, undefined);
  assert.equal(env.PREVIEW_TOKEN, undefined, "a secret override stays secret");
  assert.equal(env.DEPLO_PREVIEW, "1");
});

test("the repository's own pull request keeps every layer", async () => {
  const env = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    appEnv(APP, "preview", { preview: preview(false) }),
  );
  assert.equal(env.DATABASE_URL, "postgres://prod");
  assert.equal(env.API_KEY, "sk-live");
  assert.equal(env.FLAG, "preview");
  assert.equal(env.PREVIEW_TOKEN, "shh");
});
