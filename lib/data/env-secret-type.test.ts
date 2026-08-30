// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { encryptSecret } from "../crypto";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { loadEnvVarsForApp } from "./app-graph-load";
import {
  loadAutoInjectedVarsForApp,
  loadSharedVarsForApp,
} from "./shared-vars";

/**
 * EVERY env layer carries its `plain`/`secret` type to the deploy edge. ==
 * "secret"`, and two of the four loaders never projected the column: `undefined !
 */

let db: TestDb;
let pg: PGlite;
const T0 = "2026-01-01T00:00:00.000Z";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  await pg.exec(`
    insert into teams (id, name, slug, plan, created_at)
      values ('team_a','A','a','free','${T0}');
  `);
  await seedServer(db, "srv_1");
  await seedApp(db, {
    id: "prj_1",
    teamId: "team_a",
    slug: "app",
    serverId: "srv_1",
  });

  const enc = (v: string) => encryptSecret(v).replace(/'/g, "''");
  await pg.exec(`
    insert into env_vars (id, app_id, key, value_enc, type, created_at, updated_at)
      values ('env_1','prj_1','APP_SECRET','${enc("app")}','secret','${T0}','${T0}'),
             ('env_2','prj_1','APP_PLAIN','${enc("app")}','plain','${T0}','${T0}');
    insert into env_var_targets (env_var_id, target) values ('env_1','preview'), ('env_2','preview');

    insert into shared_env_vars (id, team_id, key, value_enc, type, created_at, updated_at)
      values ('sv_1','team_a','SHARED_SECRET','${enc("shared")}','secret','${T0}','${T0}'),
             ('sv_2','team_a','SHARED_PLAIN','${enc("shared")}','plain','${T0}','${T0}');
    insert into shared_env_var_targets (var_id, target) values ('sv_1','preview'), ('sv_2','preview');
    insert into shared_env_var_teams (var_id, team_id) values ('sv_1','team_a'), ('sv_2','team_a');
    insert into shared_env_var_apps (var_id, app_id) values ('sv_1','prj_1'), ('sv_2','prj_1');

    -- The instance-owned layer: team_id NULL, auto_inject, reaching this team.
    insert into shared_env_vars (id, team_id, key, value_enc, type, auto_inject, created_at, updated_at)
      values ('gv_1',null,'GLOBAL_SECRET','${enc("global")}','secret',true,'${T0}','${T0}'),
             ('gv_2',null,'GLOBAL_PLAIN','${enc("global")}','plain',true,'${T0}','${T0}');
    insert into shared_env_var_targets (var_id, target) values ('gv_1','preview'), ('gv_2','preview');
    insert into shared_env_var_teams (var_id, team_id) values ('gv_1','team_a'), ('gv_2','team_a');
  `);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

/** The filter `appEnv` applies for a fork preview, verbatim. */
const keep = <T extends { type: "plain" | "secret" }>(list: T[]): T[] =>
  list.filter((e) => e.type !== "secret");

const keys = (es: { key: string }[]) => es.map((e) => e.key).sort();

test("a fork preview drops the app's own secrets", async () => {
  assert.deepEqual(keys(keep(await loadEnvVarsForApp("prj_1"))), ["APP_PLAIN"]);
});

test("a fork preview drops the team's SHARED secrets", async () => {
  assert.deepEqual(keys(keep(await loadSharedVarsForApp("prj_1"))), [
    "SHARED_PLAIN",
  ]);
});

test("a fork preview drops AUTO-INJECTED secrets, which cross every team", async () => {
  assert.deepEqual(keys(keep(await loadAutoInjectedVarsForApp("prj_1"))), [
    "GLOBAL_PLAIN",
  ]);
});

/**
 * The classifier that decides the type in the first place.
 */
test("a name that announces itself as public is never typed secret", async () => {
  const { isSecretKey } = await import("./apps");

  for (const key of [
    "NEXT_PUBLIC_URL",
    "NEXT_PUBLIC_API_KEY",
    "VITE_API_URL",
    "REACT_APP_TOKEN",
    "PUBLIC_STRIPE_KEY",
  ])
    assert.equal(isSecretKey(key), false, key);

  // And the ones that ARE secrets still are.
  for (const key of [
    "DATABASE_URL",
    "API_KEY",
    "STRIPE_SECRET",
    "SMTP_PASSWORD",
  ])
    assert.equal(isSecretKey(key), true, key);
});
