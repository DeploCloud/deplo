import { test } from "node:test";
import assert from "node:assert/strict";

import { seedApp } from "../app-graph-test-helpers";
import { listApps } from "../apps/listing";
import {
  ADMIN,
  APP_IN_PRC,
  DEV,
  PRC_IN,
  ROLE,
  T0,
  as,
  capsOn,
  reaches,
  setupRoleScope,
} from "./role-scope-test-helpers";

const h = setupRoleScope();

test("an environment scope reaches one environment of a project", async () => {
  const { updateRole } = await import("../roles/role-editing");
  const envs = await import("../../db/schema/control-plane/projects");
  await h.db.insert(envs.environments).values([
    {
      id: "environ_stg",
      projectId: PRC_IN,
      name: "Staging",
      slug: "staging",
      kind: "custom",
      gitBranch: "",
      isDefault: false,
      position: 1,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "environ_prod",
      projectId: PRC_IN,
      name: "Production",
      slug: "production",
      kind: "production",
      gitBranch: "",
      isDefault: true,
      position: 0,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await seedApp(h.db, {
    id: "prj_stg",
    projectId: PRC_IN,
    environmentId: "environ_stg",
  });
  await seedApp(h.db, {
    id: "prj_prod",
    projectId: PRC_IN,
    environmentId: "environ_prod",
  });

  await as(ADMIN, () =>
    updateRole({
      id: ROLE,
      name: "Scoped",
      capabilities: ["view", "deploy_apps"],
      scope: { environmentIds: ["environ_stg"] },
    }),
  );

  assert.ok(await reaches({ kind: "app", id: "prj_stg" }));
  assert.equal(
    await reaches({ kind: "app", id: "prj_prod" }),
    false,
    "the other environment of the same project is out",
  );
  const { requireAppCapability } = await import("../node-access");
  await as(DEV, () => requireAppCapability("prj_stg", "deploy_apps"));
  await assert.rejects(
    () => as(DEV, () => requireAppCapability("prj_prod", "deploy_apps")),
    /App not found/,
  );
  assert.ok(await reaches({ kind: "project", id: PRC_IN }));
  assert.deepEqual(
    (await as(DEV, () => listApps())).map((a) => a.id),
    ["prj_stg"],
  );
});

test("an environment grant is a rung of its own, beating the project it sits in", async () => {
  const envs = await import("../../db/schema");
  await h.db.insert(envs.environments).values({
    id: "environ_stg",
    projectId: PRC_IN,
    name: "Staging",
    slug: "staging",
    kind: "custom",
    gitBranch: "",
    isDefault: false,
    position: 1,
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(h.db, {
    id: "prj_stg2",
    projectId: PRC_IN,
    environmentId: "environ_stg",
  });
  await h.db
    .insert(envs.projectGrants)
    .values({ projectId: PRC_IN, userId: DEV, capability: "view_logs" });
  await h.db.insert(envs.environmentGrants).values({
    environmentId: "environ_stg",
    userId: DEV,
    capability: "manage_env",
  });

  assert.deepEqual(await capsOn({ kind: "app", id: "prj_stg2" }), [
    "view",
    "manage_env",
  ]);
  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PRC }), [
    "view",
    "view_logs",
  ]);
  assert.deepEqual(await capsOn({ kind: "environment", id: "environ_stg" }), [
    "view",
    "manage_env",
  ]);
});
