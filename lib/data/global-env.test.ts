import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedService,
  TRUNCATE_PROJECT_GRAPH,
} from "./service-graph-test-helpers";
import {
  listTeamGlobalEnv,
  upsertTeamGlobalEnv,
  deleteTeamGlobalEnv,
  revealTeamGlobalEnv,
  listInstanceEnv,
  upsertInstanceEnv,
  loadGlobalEnvForService,
} from "./global-env";
import { upsertEnv } from "./env";
import { serviceEnvSnapshot } from "./project-backup-descriptor";

/**
 * Data-layer tests for GLOBAL env scopes (team-wide + instance-wide). Covers
 * team-scoped CRUD + isolation, secret masking/reveal, instance-admin gating,
 * and the deploy loader that resolves a project → its team's globals + instance
 * globals.
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
    truncate table team_global_env_vars, instance_env_vars restart identity cascade;
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
const asUser2 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_2", teamId: TEAM_B }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_member", teamId: TEAM_A }, fn);

test("team-global upsert is listed and team-scoped", async () => {
  await asUser1(() =>
    upsertTeamGlobalEnv({
      key: "TEAM_VAR",
      value: "v1",
      targets: [...ALL],
      type: "plain",
    }),
  );
  const a = await asUser1(() => listTeamGlobalEnv());
  assert.deepEqual(a.map((v) => v.key), ["TEAM_VAR"]);
  assert.equal(a[0]!.value, "v1");
  // Another team sees nothing.
  const b = await asUser2(() => listTeamGlobalEnv());
  assert.deepEqual(b, []);
});

test("team-global upsert updates the existing var (no duplicate)", async () => {
  await asUser1(() =>
    upsertTeamGlobalEnv({ key: "K", value: "1", targets: ["production"], type: "plain" }),
  );
  await asUser1(() =>
    upsertTeamGlobalEnv({ key: "K", value: "2", targets: [...ALL], type: "plain" }),
  );
  const list = await asUser1(() => listTeamGlobalEnv());
  assert.equal(list.length, 1);
  assert.equal(list[0]!.value, "2");
  assert.equal(list[0]!.targets.length, 3);
});

test("a secret team-global is masked in the list and revealed on demand", async () => {
  await asUser1(() =>
    upsertTeamGlobalEnv({
      key: "SECRET",
      value: "s3cr3t",
      targets: [...ALL],
      type: "secret",
    }),
  );
  const list = await asUser1(() => listTeamGlobalEnv());
  assert.equal(list[0]!.masked, true);
  assert.notEqual(list[0]!.value, "s3cr3t");
  const revealed = await asUser1(() => revealTeamGlobalEnv(list[0]!.id));
  assert.equal(revealed, "s3cr3t");
});

test("deleteTeamGlobalEnv removes it", async () => {
  await asUser1(() =>
    upsertTeamGlobalEnv({ key: "GONE", value: "x", targets: [...ALL], type: "plain" }),
  );
  const [v] = await asUser1(() => listTeamGlobalEnv());
  await asUser1(() => deleteTeamGlobalEnv(v!.id));
  assert.deepEqual(await asUser1(() => listTeamGlobalEnv()), []);
});

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

test("loadGlobalEnvForService returns the project team's globals + instance globals", async () => {
  await seedService(db, { id: "prj1", teamId: TEAM_A, serverId: "srv_1" });
  await asUser1(() =>
    upsertTeamGlobalEnv({ key: "TEAM", value: "t", targets: ["production"], type: "plain" }),
  );
  await asUser1(() =>
    upsertInstanceEnv({ key: "INST", value: "i", targets: ["production"], type: "plain" }),
  );

  const { teamGlobals, instanceGlobals } = await loadGlobalEnvForService("prj1");
  assert.deepEqual(teamGlobals.map((e) => e.key), ["TEAM"]);
  assert.deepEqual(instanceGlobals.map((e) => e.key), ["INST"]);
  // The loader returns encrypted entries (decrypt happens at the deploy edge).
  assert.ok(teamGlobals[0]!.valueEnc.length > 0);
  assert.deepEqual(teamGlobals[0]!.targets, ["production"]);
});

test("editing a secret with the MASK keeps the stored value (targets-only edit)", async () => {
  await asUser1(() =>
    upsertTeamGlobalEnv({
      key: "S",
      value: "real",
      targets: ["production"],
      type: "secret",
    }),
  );
  const [v] = await asUser1(() => listTeamGlobalEnv());
  // Re-upsert with the MASK sentinel + more targets — value preserved, targets updated.
  await asUser1(() =>
    upsertTeamGlobalEnv({
      key: "S",
      value: "••••••••••••",
      targets: [...ALL],
      type: "secret",
    }),
  );
  assert.equal(await asUser1(() => revealTeamGlobalEnv(v!.id)), "real");
  const [v2] = await asUser1(() => listTeamGlobalEnv());
  assert.equal(v2!.targets.length, 3);
});

test("serviceEnvSnapshot (backup) includes team + instance globals, project wins", async () => {
  await seedService(db, { id: "prjX", teamId: TEAM_A, serverId: "srv_1" });
  await asUser1(async () => {
    await upsertInstanceEnv({ key: "IG", value: "ival", targets: ["production"], type: "plain" });
    await upsertTeamGlobalEnv({ key: "TG", value: "tval", targets: ["production"], type: "plain" });
    await upsertTeamGlobalEnv({ key: "DUP", value: "team", targets: ["production"], type: "plain" });
    await upsertEnv({ serviceId: "prjX", key: "DUP", value: "service", targets: ["production"], type: "plain" });
  });
  const snap = await serviceEnvSnapshot("prjX");
  assert.equal(snap.IG, "ival", "instance global captured");
  assert.equal(snap.TG, "tval", "team global captured");
  assert.equal(snap.DUP, "service", "project var overrides team global");
});

test("loadGlobalEnvForService for a project in a team WITHOUT team globals still gets instance globals", async () => {
  await seedService(db, { id: "prj2", teamId: TEAM_B, serverId: "srv_1" });
  await asUser1(() =>
    upsertInstanceEnv({ key: "INST", value: "i", targets: [...ALL], type: "plain" }),
  );
  const { teamGlobals, instanceGlobals } = await loadGlobalEnvForService("prj2");
  assert.deepEqual(teamGlobals, []);
  assert.deepEqual(instanceGlobals.map((e) => e.key), ["INST"]);
});
