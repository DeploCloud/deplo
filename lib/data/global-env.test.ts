import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  listInstanceEnv,
  upsertInstanceEnv,
  deleteInstanceEnv,
  revealInstanceEnv,
  loadInstanceEnv,
} from "./global-env";
import { upsertEnv } from "./env";
import { appEnvSnapshot } from "./project-backup-descriptor";

/**
 * Data-layer tests for INSTANCE-wide global env vars (the one scope that survives
 * ADR-0010; team-global vars became team-wide shared vars — see shared-vars.test).
 * Covers instance-admin gating, secret masking/reveal, the MASK keep-value edit,
 * the deploy loader, and the backup snapshot.
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

const ALL = ["production", "preview", "development"] as const;

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table instance_env_vars restart identity cascade;
    truncate table registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" }, // owner ⇒ instance admin
      { id: "user_2", teamId: TEAM_B, role: "owner" },
      // member: has manage_env (team), but NOT instance admin.
      { id: "user_member", teamId: TEAM_A, role: "member" },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_member", teamId: TEAM_A }, fn);

test("instance env requires an instance admin", async () => {
  await assert.rejects(
    asMember(() =>
      upsertInstanceEnv({ key: "X", value: "1", targets: [...ALL], type: "plain" }),
    ),
    /instance admin/i,
  );
  // The owner (instance admin) can.
  await asUser1(() =>
    upsertInstanceEnv({ key: "X", value: "1", targets: [...ALL], type: "plain" }),
  );
  const list = await asUser1(() => listInstanceEnv());
  assert.deepEqual(list.map((v) => v.key), ["X"]);
});

test("instance upsert updates the existing var (no duplicate)", async () => {
  await asUser1(() =>
    upsertInstanceEnv({ key: "K", value: "1", targets: ["production"], type: "plain" }),
  );
  await asUser1(() =>
    upsertInstanceEnv({ key: "K", value: "2", targets: [...ALL], type: "plain" }),
  );
  const list = await asUser1(() => listInstanceEnv());
  assert.equal(list.length, 1);
  assert.equal(list[0]!.value, "2");
  assert.equal(list[0]!.targets.length, 3);
});

test("a secret instance global is masked in the list and revealed on demand", async () => {
  await asUser1(() =>
    upsertInstanceEnv({ key: "SECRET", value: "s3cr3t", targets: [...ALL], type: "secret" }),
  );
  const list = await asUser1(() => listInstanceEnv());
  assert.equal(list[0]!.masked, true);
  assert.notEqual(list[0]!.value, "s3cr3t");
  assert.equal(await asUser1(() => revealInstanceEnv(list[0]!.id)), "s3cr3t");
});

test("deleteInstanceEnv removes it", async () => {
  await asUser1(() =>
    upsertInstanceEnv({ key: "GONE", value: "x", targets: [...ALL], type: "plain" }),
  );
  const [v] = await asUser1(() => listInstanceEnv());
  await asUser1(() => deleteInstanceEnv(v!.id));
  assert.deepEqual(await asUser1(() => listInstanceEnv()), []);
});

test("editing a secret with the MASK keeps the stored value (targets-only edit)", async () => {
  await asUser1(() =>
    upsertInstanceEnv({ key: "S", value: "real", targets: ["production"], type: "secret" }),
  );
  const [v] = await asUser1(() => listInstanceEnv());
  // Re-upsert with the MASK sentinel + more targets — value preserved, targets updated.
  await asUser1(() =>
    upsertInstanceEnv({ key: "S", value: "••••••••••••", targets: [...ALL], type: "secret" }),
  );
  assert.equal(await asUser1(() => revealInstanceEnv(v!.id)), "real");
  const [v2] = await asUser1(() => listInstanceEnv());
  assert.equal(v2!.targets.length, 3);
});

test("loadInstanceEnv returns instance globals (encrypted, targeted)", async () => {
  await asUser1(() =>
    upsertInstanceEnv({ key: "INST", value: "i", targets: ["production"], type: "plain" }),
  );
  const globals = await loadInstanceEnv();
  assert.deepEqual(globals.map((e) => e.key), ["INST"]);
  // The loader returns encrypted entries (decrypt happens at the deploy edge).
  assert.ok(globals[0]!.valueEnc.length > 0);
  assert.deepEqual(globals[0]!.targets, ["production"]);
});

test("appEnvSnapshot (backup) includes instance globals + the app's own vars", async () => {
  await seedApp(db, { id: "prjX", teamId: TEAM_A, serverId: "srv_1" });
  await asUser1(async () => {
    await upsertInstanceEnv({ key: "IG", value: "ival", targets: ["production"], type: "plain" });
    await upsertEnv({ appId: "prjX", key: "OWN", value: "oval", targets: ["production"], type: "plain" });
  });
  const snap = await appEnvSnapshot("prjX");
  assert.equal(snap.IG, "ival", "instance global captured");
  assert.equal(snap.OWN, "oval", "app-own var captured");
});
