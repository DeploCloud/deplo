import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { folderGrants as folderGrantsTable } from "../../db/schema/control-plane/access-control";
import { projects as projectsTable } from "../../db/schema/control-plane/projects";
import { listApps } from "../apps/listing";
import { listFolders } from "../folders";
import {
  APP_IN_CHILD,
  APP_IN_FLD,
  APP_IN_PRC,
  APP_OUT_FLD,
  APP_OUT_PRC,
  APP_TOP,
  ADMIN,
  DEV,
  FLD_CHILD,
  FLD_IN,
  FLD_OUT,
  PRC_IN,
  PRC_OUT,
  as,
  capsOn,
  reaches,
  scopeTo,
  setupRoleScope,
} from "./role-scope-test-helpers";

const h = setupRoleScope();

test("an unscoped role reaches the whole team, as every role does today", async () => {
  assert.ok(await reaches({ kind: "app", id: APP_IN_PRC }));
  assert.ok(await reaches({ kind: "app", id: APP_OUT_PRC }));
  assert.ok(await reaches({ kind: "app", id: APP_TOP }));
  assert.ok(await reaches({ kind: "project", id: PRC_OUT }));
  // Folders are private to their owner and grantees (ADR-0016), so ADMIN's answer nothing either way.
  assert.equal(await reaches({ kind: "folder", id: FLD_IN }), false);
});

test("a project scope reaches its apps and its container, and nothing else", async () => {
  await scopeTo(h, { projects: [PRC_IN] });

  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PRC }), [
    "view",
    "deploy_apps",
  ]);
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_OUT_PRC }),
    [],
    "an app in the other project is gone",
  );
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_TOP }),
    [],
    "and so is one at the team top level, which no scope covers",
  );
  assert.ok(await reaches({ kind: "project", id: PRC_IN }));
  assert.equal(await reaches({ kind: "project", id: PRC_OUT }), false);
});

test("a folder scope reaches its whole subtree", async () => {
  await scopeTo(h, { folders: [FLD_IN] });

  assert.ok(await reaches({ kind: "folder", id: FLD_IN }));
  assert.ok(await reaches({ kind: "folder", id: FLD_CHILD }));
  assert.ok(await reaches({ kind: "app", id: APP_IN_FLD }));
  assert.ok(await reaches({ kind: "app", id: APP_IN_CHILD }));
  assert.equal(await reaches({ kind: "folder", id: FLD_OUT }), false);
  assert.equal(await reaches({ kind: "app", id: APP_OUT_FLD }), false);

  assert.deepEqual(
    (await as(DEV, () => listFolders())).map((f) => f.id).sort(),
    [FLD_CHILD, FLD_IN].sort(),
  );
  assert.deepEqual(
    (await as(DEV, () => listApps())).map((a) => a.id).sort(),
    [APP_IN_CHILD, APP_IN_FLD].sort(),
  );
});

test("naming one app reaches that app alone", async () => {
  await scopeTo(h, { apps: [APP_TOP] });
  assert.ok(await reaches({ kind: "app", id: APP_TOP }));
  assert.equal(await reaches({ kind: "app", id: APP_IN_PRC }), false);
  assert.deepEqual(
    (await as(DEV, () => listApps())).map((a) => a.id),
    [APP_TOP],
  );
});

test("naming one app keeps the project that holds it navigable", async () => {
  await scopeTo(h, { apps: [APP_IN_PRC] });

  assert.ok(await reaches({ kind: "app", id: APP_IN_PRC }));
  assert.ok(
    await reaches({ kind: "project", id: PRC_IN }),
    "the project holding the named app was not navigable",
  );
  assert.equal(await reaches({ kind: "project", id: PRC_OUT }), false);
  const { listProjects } = await import("../projects/read");
  assert.deepEqual(
    (await as(DEV, () => listProjects())).map((p) => p.id),
    [PRC_IN],
  );
});

test("a scope emptied by a cascade reaches nothing, not everything", async () => {
  await scopeTo(h, { projects: [PRC_IN] });
  assert.ok(await reaches({ kind: "app", id: APP_IN_PRC }));

  await h.db.delete(projectsTable).where(eq(projectsTable.id, PRC_IN));
  assert.deepEqual(await as(DEV, () => listApps()), []);
  assert.equal(await reaches({ kind: "app", id: APP_OUT_PRC }), false);
  assert.equal(await reaches({ kind: "app", id: APP_TOP }), false);
});

test("a folder share extends the scope instead of being clamped by it", async () => {
  await scopeTo(h, { projects: [PRC_IN] });
  assert.equal(await reaches({ kind: "folder", id: FLD_OUT }), false);

  await h.db
    .insert(folderGrantsTable)
    .values({ folderId: FLD_OUT, userId: DEV, capability: "manage_env" });

  assert.deepEqual(await capsOn({ kind: "folder", id: FLD_OUT }), [
    "view",
    "manage_env",
  ]);
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_OUT_FLD }),
    ["view", "manage_env"],
    "and the apps inside it, with the granted set rather than the role's",
  );
  assert.equal(await reaches({ kind: "app", id: APP_OUT_PRC }), false);
});

test("manage_team does not lift a scope, only instance admin does", async () => {
  await scopeTo(h, { projects: [PRC_IN] });
  await h.pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'manage_team' from memberships where user_id = '${DEV}'`,
  );
  assert.equal(
    await reaches({ kind: "app", id: APP_OUT_PRC }),
    false,
    "a scoped member with manage_team resolved the whole team",
  );
  assert.deepEqual(
    (await as(DEV, () => listFolders())).map((f) => f.id),
    [],
    "nor every folder in it",
  );

  assert.ok((await as(ADMIN, () => listApps())).length > 0);
});
