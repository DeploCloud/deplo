import { test } from "node:test";
import assert from "node:assert/strict";

import { listApps } from "../apps/listing";
import { listFolders } from "../folders";
import {
  ADMIN,
  APP_IN_CHILD,
  APP_IN_FLD,
  APP_IN_PRC,
  APP_OUT_PRC,
  APP_TOP,
  DEV,
  FLD_CHILD,
  FLD_IN,
  FLD_OUT,
  ROLE,
  as,
  capsOn,
  reaches,
  setupRoleScope,
  updateRoleCaps,
} from "./role-scope-test-helpers";

setupRoleScope();

test("a member limited to one folder stops reaching the rest of the team", async () => {
  const { setMemberAccess } = await import("../user-access");

  assert.ok(await reaches({ kind: "app", id: APP_OUT_PRC }));
  assert.ok(await reaches({ kind: "app", id: APP_TOP }));

  await as(ADMIN, () =>
    setMemberAccess({
      userId: DEV,
      roleId: ROLE,
      granular: true,
      grants: [{ folderIds: [FLD_IN], capabilities: ["view", "deploy_apps"] }],
      capabilities: ["view", "deploy_apps"],
    }),
  );

  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_FLD }), [
    "view",
    "deploy_apps",
  ]);
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_IN_CHILD }),
    ["view", "deploy_apps"],
    "and the subtree under it",
  );
  assert.equal(
    await reaches({ kind: "app", id: APP_OUT_PRC }),
    false,
    "an app their role still reaches, and they no longer do",
  );
  assert.equal(await reaches({ kind: "app", id: APP_TOP }), false);
  assert.deepEqual(
    (await as(DEV, () => listApps())).map((a) => a.id).sort(),
    [APP_IN_CHILD, APP_IN_FLD].sort(),
    "the list agrees with the gate",
  );
  assert.deepEqual(
    (await as(DEV, () => listFolders())).map((f) => f.id).sort(),
    [FLD_CHILD, FLD_IN].sort(),
    "the folder they were given, its subtree, and no sibling of it",
  );
});

test("a permission taken from one member survives the next role edit", async () => {
  const { setMemberAccess } = await import("../user-access");
  const { updateRole } = await import("../roles/role-editing");
  const { listMembers } = await import("../members/roster");

  await as(ADMIN, () =>
    setMemberAccess({
      userId: DEV,
      roleId: ROLE,
      granular: false,
      grants: [],
      capabilities: ["view"],
    }),
  );
  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PRC }), ["view"]);

  await as(ADMIN, () =>
    updateRole({
      id: ROLE,
      name: "Renamed",
      capabilities: ["view", "deploy_apps"],
    }),
  );
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_IN_PRC }),
    ["view"],
    "the role edit reached back into a member an admin had cut down",
  );

  const dev = (await as(ADMIN, () => listMembers())).find(
    (m) => m.userId === DEV,
  );
  assert.equal(dev?.accessDelta, "less");
});

test("a member who follows their role still follows a role edit", async () => {
  const { updateRole } = await import("../roles/role-editing");
  const { listMembers } = await import("../members/roster");

  await as(ADMIN, () =>
    updateRole({
      id: ROLE,
      name: "Scoped",
      capabilities: ["view", "deploy_apps", "view_logs"],
    }),
  );
  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PRC }), [
    "view",
    "deploy_apps",
    "view_logs",
  ]);
  const dev = (await as(ADMIN, () => listMembers())).find(
    (m) => m.userId === DEV,
  );
  assert.equal(dev?.accessDelta, null, "nothing about them differs from it");
});

test("a member given more than their role keeps it, and reads as more", async () => {
  const { setMemberAccess } = await import("../user-access");
  const { listMembers } = await import("../members/roster");

  await as(ADMIN, () =>
    setMemberAccess({
      userId: DEV,
      roleId: ROLE,
      granular: false,
      grants: [],
      capabilities: ["view", "deploy_apps", "view_logs"],
    }),
  );
  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PRC }), [
    "view",
    "deploy_apps",
    "view_logs",
  ]);
  const dev = (await as(ADMIN, () => listMembers())).find(
    (m) => m.userId === DEV,
  );
  assert.equal(dev?.accessDelta, "more");
});

test("a limited member never resolves as a team administrator", async () => {
  const { setMemberAccess } = await import("../user-access");
  const { hasCapability } = await import("../../membership");

  await as(ADMIN, () =>
    updateRoleCaps(["view", "deploy_apps", "manage_team", "manage_members"]),
  );
  await as(ADMIN, () =>
    setMemberAccess({
      userId: DEV,
      roleId: ROLE,
      granular: true,
      grants: [{ folderIds: [FLD_IN], capabilities: ["view", "deploy_apps"] }],
      capabilities: ["view", "deploy_apps", "manage_team", "manage_members"],
    }),
  );

  assert.equal(await as(DEV, () => hasCapability("manage_team")), false);
  assert.equal(await as(DEV, () => hasCapability("manage_members")), false);
  assert.equal(
    await reaches({ kind: "folder", id: FLD_OUT }),
    false,
    "a folder they were never shown stays invisible",
  );
});
