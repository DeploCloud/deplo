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
import { createProject, moveServiceToProject } from "./projects";
import { listEnvironmentsForProject, createEnvironment } from "./environments";
import {
  listEnvironmentEnv,
  listProjectEnvironmentEnv,
  upsertEnvironmentEnv,
  deleteEnvironmentEnv,
  revealEnvironmentEnv,
  loadEnvironmentEnvForService,
} from "./environment-env";
import { upsertEnv } from "./env";
import { upsertTeamGlobalEnv } from "./global-env";
import { serviceEnvSnapshot } from "./project-backup-descriptor";

/**
 * Data-layer tests for ENVIRONMENT-scoped shared env vars (ADR-0008 Phase 3):
 * per-environment CRUD + team isolation, secret masking/reveal, the MASK
 * keep-value contract, and the deploy loader + full resolve precedence
 * (team-global < environment < a service's own var) through the backup
 * snapshot, which shares build.ts's exact resolver seam.
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
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table environment_env_vars, environments, team_project_order, project_grants, projects restart identity cascade;
    truncate table team_global_env_vars, instance_env_vars restart identity cascade;
    truncate table registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
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
const asUser2 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_2", teamId: TEAM_B }, fn);

/** Create a project in TEAM_A and return its seeded Production environment id. */
async function seedProjectWithProduction(): Promise<{
  projectId: string;
  productionId: string;
}> {
  return asUser1(async () => {
    const p = await createProject("Shop", null);
    const envs = await listEnvironmentsForProject(p.id);
    const production = envs.find((e) => e.kind === "production")!;
    return { projectId: p.id, productionId: production.id };
  });
}

test("upsert lands in the environment's list; plain values display", async () => {
  const { productionId } = await seedProjectWithProduction();
  await asUser1(() =>
    upsertEnvironmentEnv({
      environmentId: productionId,
      key: "API_URL",
      value: "https://api.example.com",
      type: "plain",
    }),
  );
  const list = await asUser1(() => listEnvironmentEnv(productionId));
  assert.deepEqual(list.map((v) => v.key), ["API_URL"]);
  assert.equal(list[0]!.value, "https://api.example.com");
  assert.equal(list[0]!.masked, false);
});

test("upsert updates the existing var (no duplicate on the same key)", async () => {
  const { productionId } = await seedProjectWithProduction();
  await asUser1(() =>
    upsertEnvironmentEnv({ environmentId: productionId, key: "K", value: "1", type: "plain" }),
  );
  await asUser1(() =>
    upsertEnvironmentEnv({ environmentId: productionId, key: "K", value: "2", type: "plain" }),
  );
  const list = await asUser1(() => listEnvironmentEnv(productionId));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.value, "2");
});

test("a secret is masked in the list and revealed on demand", async () => {
  const { productionId } = await seedProjectWithProduction();
  await asUser1(() =>
    upsertEnvironmentEnv({
      environmentId: productionId,
      key: "SECRET",
      value: "s3cr3t",
      type: "secret",
    }),
  );
  const [v] = await asUser1(() => listEnvironmentEnv(productionId));
  assert.equal(v!.masked, true);
  assert.notEqual(v!.value, "s3cr3t");
  assert.equal(await asUser1(() => revealEnvironmentEnv(v!.id)), "s3cr3t");
});

test("editing a secret with the MASK keeps the stored value", async () => {
  const { productionId } = await seedProjectWithProduction();
  await asUser1(() =>
    upsertEnvironmentEnv({
      environmentId: productionId,
      key: "S",
      value: "real",
      type: "secret",
    }),
  );
  const [v] = await asUser1(() => listEnvironmentEnv(productionId));
  await asUser1(() =>
    upsertEnvironmentEnv({
      environmentId: productionId,
      key: "S",
      value: "••••••••••••",
      type: "secret",
    }),
  );
  assert.equal(await asUser1(() => revealEnvironmentEnv(v!.id)), "real");
});

test("deleteEnvironmentEnv removes it", async () => {
  const { productionId } = await seedProjectWithProduction();
  await asUser1(() =>
    upsertEnvironmentEnv({ environmentId: productionId, key: "GONE", value: "x", type: "plain" }),
  );
  const [v] = await asUser1(() => listEnvironmentEnv(productionId));
  await asUser1(() => deleteEnvironmentEnv(v!.id));
  assert.deepEqual(await asUser1(() => listEnvironmentEnv(productionId)), []);
});

test("another team can neither list nor edit the environment's vars", async () => {
  const { productionId } = await seedProjectWithProduction();
  await assert.rejects(
    asUser2(() => listEnvironmentEnv(productionId)),
    /not found/i,
  );
  await assert.rejects(
    asUser2(() =>
      upsertEnvironmentEnv({ environmentId: productionId, key: "X", value: "1", type: "plain" }),
    ),
    /not found/i,
  );
});

test("listProjectEnvironmentEnv groups per environment, empty ones included", async () => {
  const { projectId, productionId } = await seedProjectWithProduction();
  await asUser1(async () => {
    await createEnvironment(projectId, "Staging");
    await upsertEnvironmentEnv({
      environmentId: productionId,
      key: "ONLY_PROD",
      value: "v",
      type: "plain",
    });
  });
  const groups = await asUser1(() => listProjectEnvironmentEnv(projectId));
  // Seeded Development/Preview/Production + the custom Staging, display order.
  assert.deepEqual(
    groups.map((g) => g.environmentName),
    ["Development", "Preview", "Production", "Staging"],
  );
  const production = groups.find((g) => g.environmentId === productionId)!;
  assert.deepEqual(production.vars.map((v) => v.key), ["ONLY_PROD"]);
  assert.equal(groups.find((g) => g.environmentName === "Staging")!.vars.length, 0);
});

test("loadEnvironmentEnvForService: project services get entries with kind; ungrouped get none", async () => {
  const { projectId, productionId } = await seedProjectWithProduction();
  await seedService(db, { id: "prj_in", teamId: TEAM_A, serverId: "srv_1" });
  await seedService(db, { id: "prj_out", teamId: TEAM_A, serverId: "srv_1", slug: "out" });
  await asUser1(async () => {
    await moveServiceToProject("prj_in", projectId);
    await upsertEnvironmentEnv({
      environmentId: productionId,
      key: "SHARED",
      value: "v",
      type: "plain",
    });
  });
  const entries = await loadEnvironmentEnvForService("prj_in");
  assert.deepEqual(
    entries.map((e) => ({ key: e.key, kind: e.kind })),
    [{ key: "SHARED", kind: "production" }],
  );
  assert.deepEqual(await loadEnvironmentEnvForService("prj_out"), []);
});

test("resolve precedence through the deploy seam: team-global < environment < service", async () => {
  const { projectId, productionId } = await seedProjectWithProduction();
  await seedService(db, { id: "prjX", teamId: TEAM_A, serverId: "srv_1" });
  await asUser1(async () => {
    await moveServiceToProject("prjX", projectId);
    await upsertTeamGlobalEnv({
      key: "DUP",
      value: "team",
      targets: ["production"],
      type: "plain",
    });
    await upsertEnvironmentEnv({
      environmentId: productionId,
      key: "DUP",
      value: "environment",
      type: "plain",
    });
    await upsertEnvironmentEnv({
      environmentId: productionId,
      key: "ENV_ONLY",
      value: "shared",
      type: "plain",
    });
    await upsertEnv({
      serviceId: "prjX",
      key: "OWN_WINS",
      value: "service",
      targets: ["production"],
      type: "plain",
    });
    await upsertEnvironmentEnv({
      environmentId: productionId,
      key: "OWN_WINS",
      value: "environment",
      type: "plain",
    });
  });
  const snap = await serviceEnvSnapshot("prjX");
  assert.equal(snap.DUP, "environment", "environment var overrides the team global");
  assert.equal(snap.ENV_ONLY, "shared", "environment var reaches every project service");
  assert.equal(snap.OWN_WINS, "service", "a service's own var overrides the environment's");
});

test("only the production-kind environment reaches the production snapshot; custom stays inert", async () => {
  const { projectId } = await seedProjectWithProduction();
  await seedService(db, { id: "prjY", teamId: TEAM_A, serverId: "srv_1" });
  const { devId, customId } = await asUser1(async () => {
    await moveServiceToProject("prjY", projectId);
    const envs = await listEnvironmentsForProject(projectId);
    const custom = await createEnvironment(projectId, "Staging");
    return {
      devId: envs.find((e) => e.kind === "development")!.id,
      customId: custom.id,
    };
  });
  await asUser1(async () => {
    await upsertEnvironmentEnv({
      environmentId: devId,
      key: "DEV_VAR",
      value: "d",
      type: "plain",
    });
    await upsertEnvironmentEnv({
      environmentId: customId,
      key: "CUSTOM_VAR",
      value: "c",
      type: "plain",
    });
  });
  const snap = await serviceEnvSnapshot("prjY");
  assert.equal(snap.DEV_VAR, undefined, "a development-kind var never reaches production");
  assert.equal(snap.CUSTOM_VAR, undefined, "a custom environment matches no legacy runtime");
});
