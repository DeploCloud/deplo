import { test } from "node:test";
import assert from "node:assert/strict";

import { activities as activitiesTable } from "../../db/schema/control-plane/activity";
import { TEAM_A } from "../identity-test-helpers";
import {
  ADMIN,
  APP_IN_PRC,
  APP_OUT_PRC,
  DEV,
  PRC_IN,
  PRC_OUT,
  T0,
  as,
  scopeTo,
  setupRoleScope,
} from "./role-scope-test-helpers";

const h = setupRoleScope();

test("the reads the dashboard layout makes still answer a scoped member", async () => {
  const { getTeamIdentity } = await import("../teams");
  const { reachableCapabilities } = await import("../../membership");
  const { getBreadcrumbGraph } = await import("../breadcrumb");
  const { listMyTeams } = await import("../teams");

  await scopeTo(h, { projects: [PRC_IN] });

  await as(DEV, async () => {
    const team = await getTeamIdentity();
    assert.equal(
      team.id,
      TEAM_A,
      "the topbar must still be able to name the team",
    );
    await reachableCapabilities();
    await getBreadcrumbGraph();
    await listMyTeams();
  });
});

test("the app pages a scoped member owns still load", async () => {
  const { listEnv } = await import("../env");
  const { listSharedVarsForApp } = await import("../shared-vars/app-view");
  const { listBackups } = await import("../backups/schedules");
  const { listBackupRuns } = await import("../backups/run-listing");
  const { listDomains } = await import("../domains/crud");
  const { listDeployments } = await import("../deployments/deployment-queries");

  await scopeTo(h, { projects: [PRC_IN] });

  await as(DEV, async () => {
    await listEnv(APP_IN_PRC);
    await listSharedVarsForApp(APP_IN_PRC);
    await listBackups();
    await listBackupRuns({ appId: APP_IN_PRC });
    await listDomains(APP_IN_PRC);
    await listDeployments({ appId: APP_IN_PRC });
  });
});

test("no list read hands a scoped member anything outside their scope", async () => {
  const reads: [string, () => Promise<unknown>][] = [
    ["listApps", async () => (await import("../apps/listing")).listApps()],
    [
      "listProjects",
      async () => (await import("../projects/read")).listProjects(),
    ],
    ["listFolders", async () => (await import("../folders")).listFolders()],
    [
      "getBreadcrumbGraph",
      async () => (await import("../breadcrumb")).getBreadcrumbGraph(),
    ],
    ["listActivity", async () => (await import("../activity")).listActivity()],
    ["listAllAppEnv", async () => (await import("../env")).listAllAppEnv()],
    [
      "listDeployments",
      async () =>
        (await import("../deployments/deployment-queries")).listDeployments(),
    ],
    [
      "listDomains",
      async () => (await import("../domains/crud")).listDomains(),
    ],
    [
      "projectContents",
      async () => (await import("../projects/read")).projectContents(PRC_OUT),
    ],
  ];

  await scopeTo(h, { projects: [PRC_IN] });

  for (const [name, call] of reads) {
    const json = JSON.stringify(await as(DEV, call));
    for (const secret of [APP_OUT_PRC, PRC_OUT, "out-app"]) {
      assert.ok(
        !json.includes(secret),
        `${name} named ${secret}, which is outside the member's scope`,
      );
    }
  }
});

test("the trail and the shared library are cut to what they reach", async () => {
  const { listActivity } = await import("../activity");
  const { listSharedVarsForApp } = await import("../shared-vars/app-view");
  const { saveSharedVar } = await import("../shared-vars/authoring");

  await h.db.insert(activitiesTable).values([
    {
      id: "act_out",
      teamId: TEAM_A,
      type: "app",
      message: "OUT-APP-EVENT",
      actor: "someone",
      appId: APP_OUT_PRC,
      createdAt: T0,
    },
    {
      id: "act_team",
      teamId: TEAM_A,
      type: "member",
      message: "TEAM-LEVEL-EVENT",
      actor: "someone",
      appId: null,
      createdAt: T0,
    },
  ]);
  await as(ADMIN, () =>
    saveSharedVar({
      key: "TEAM_WIDE",
      value: "PLAINTEXT-VALUE",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );

  await scopeTo(h, { projects: [PRC_IN] });
  await h.pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'view_activity' from memberships where user_id = '${DEV}'
     union all
     select id, 'manage_env' from memberships where user_id = '${DEV}'`,
  );

  const trail = JSON.stringify(await as(DEV, () => listActivity()));
  assert.ok(
    !trail.includes("OUT-APP-EVENT"),
    "the trail named an app they can't reach",
  );
  assert.ok(!trail.includes("TEAM-LEVEL-EVENT"), "nor the team's own history");

  const vars = JSON.stringify(
    await as(DEV, () => listSharedVarsForApp(APP_IN_PRC)),
  );
  assert.ok(
    !vars.includes("PLAINTEXT-VALUE"),
    "the team's shared library came back from an app inside the scope",
  );
});
