import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { encryptSecret } from "../crypto";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { loadEnvVarsForApp } from "./app-graph-load";
import { loadSharedVarsForApp } from "./shared-vars";
import { loadInstanceEnv } from "./global-env";

/**
 * EVERY env layer carries its `plain`/`secret` type to the deploy edge.
 *
 * `appEnv` in lib/deploy/build.ts drops secret-typed values from a preview whose
 * pull request came from a FORK - the code there, the comment on
 * `lib/data/previews.ts:approvePreview` and `schema.graphql` all say so. The
 * filter asked `e.type !== "secret"`, and two of the four loaders never
 * projected the column: `undefined !== "secret"` is true, so a team's shared
 * secrets and every instance-global secret went straight through the one thing
 * meant to stop them.
 *
 * The types now REQUIRE `type`, so the compiler catches a loader that forgets.
 * This is the runtime half: the column has to arrive with the right VALUE, and
 * no cast can prove that.
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

    insert into shared_env_vars (id, team_id, key, value_enc, type, team_wide, created_at, updated_at)
      values ('sv_1','team_a','SHARED_SECRET','${enc("shared")}','secret',true,'${T0}','${T0}'),
             ('sv_2','team_a','SHARED_PLAIN','${enc("shared")}','plain',true,'${T0}','${T0}');
    insert into shared_env_var_targets (var_id, target) values ('sv_1','preview'), ('sv_2','preview');
    insert into shared_env_var_apps (var_id, app_id) values ('sv_1','prj_1'), ('sv_2','prj_1');

    insert into instance_env_vars (id, key, value_enc, type, created_at, updated_at)
      values ('gv_1','GLOBAL_SECRET','${enc("global")}','secret','${T0}','${T0}'),
             ('gv_2','GLOBAL_PLAIN','${enc("global")}','plain','${T0}','${T0}');
    insert into instance_env_var_targets (env_var_id, target) values ('gv_1','preview'), ('gv_2','preview');
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

test("a fork preview drops INSTANCE-GLOBAL secrets, which cross every team", async () => {
  assert.deepEqual(keys(keep(await loadInstanceEnv())), ["GLOBAL_PLAIN"]);
});
