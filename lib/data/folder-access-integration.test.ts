import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { folderGrants as folderGrantsTable } from "../db/schema/control-plane/access-control";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { folders as foldersTable } from "../db/schema/control-plane/projects";
import { runWithIdentity } from "../auth/request-context";
import { currentCapabilities } from "../membership";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { seedS3 } from "./backup-test-helpers";
import { createApp } from "./apps/create";
import { getAppBySlug, listApps } from "./apps/listing";
import { renameApp } from "./apps/settings";
import { runAppBackup } from "./backups/run-now";
import { createBackup, deleteBackup } from "./backups/schedules";
import {
  folderCapabilities,
  setFolderGrant,
  listFolderGrants,
} from "./folder-access";
import { listFolders } from "./folders";

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

const T0 = "2026-01-01T00:00:00.000Z";

const OWNER = "u_owner";
const MEMBER = "u_member";
const GRANTEE = "u_grantee";
const INFRA = "u_infra";
const FLD = "fld_secret";
const PRJ_IN = "prj_in_folder";
const PRJ_TOP = "prj_top_level";

const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

beforeEach(async () => {
  await pg.exec(`truncate table
    folder_grants, backup_runs, backups, backup_destination,
    app_build_method_settings, app_build, apps, folders, servers,
    membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      {
        id: MEMBER,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: [
          "view",
          "create_apps",
          "deploy_apps",
          "configure_apps",
          "manage_domains",
          "manage_env",
        ],
      },
      {
        id: GRANTEE,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: [
          "view",
          "create_apps",
          "deploy_apps",
          "configure_apps",
          "manage_domains",
          "manage_env",
        ],
      },
      {
        id: INFRA,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "manage_backups"],
      },
    ],
  });
  await seedServer(db);
  await seedS3(db, { id: "s3_1" });
  await db.insert(foldersTable).values({
    id: FLD,
    teamId: TEAM_A,
    name: "Secret",
    parentId: null,
    color: null,
    ownerUserId: OWNER,
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(db, { id: PRJ_IN, teamId: TEAM_A });
  await seedApp(db, { id: PRJ_TOP, teamId: TEAM_A });
  await db
    .update(appsTable)
    .set({ folderId: FLD })
    .where(eq(appsTable.id, PRJ_IN));
});

test("a team member without folder access can't act on a project inside the folder", async () => {
  await as(MEMBER, async () => {
    await assert.rejects(
      () => renameApp(PRJ_IN, "hijacked"),
      /not found|permission/i,
      "team deploy alone must NOT let a non-folder-member rename a project in the folder",
    );
  });
  const row = (
    await db.select().from(appsTable).where(eq(appsTable.id, PRJ_IN))
  )[0]!;
  assert.equal(
    row.name,
    PRJ_IN,
    "project name unchanged after the blocked rename",
  );
});

test("an app in a folder they can't see is INVISIBLE, not merely unwritable", async () => {
  await as(MEMBER, async () => {
    assert.deepEqual(
      (await listApps()).map((a) => a.id),
      [PRJ_TOP],
      "the folder's app is filtered out of the list",
    );
    assert.equal(
      await getAppBySlug(PRJ_IN),
      null,
      "and its page refuses to load",
    );
    assert.ok(await getAppBySlug(PRJ_TOP), "the top-level app still opens");
  });

  await as(OWNER, async () => {
    assert.deepEqual((await listApps()).map((a) => a.id).sort(), [
      PRJ_IN,
      PRJ_TOP,
    ]);
  });
  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, ["configure_apps"]));
  await as(GRANTEE, async () => {
    assert.deepEqual((await listApps()).map((a) => a.id).sort(), [
      PRJ_IN,
      PRJ_TOP,
    ]);
    assert.ok(await getAppBySlug(PRJ_IN), "the granted folder's app opens");
  });
});

test("the same member CAN act on a TOP-LEVEL project (team caps govern)", async () => {
  await as(MEMBER, async () => {
    await renameApp(PRJ_TOP, "renamed-top");
  });
  const row = (
    await db.select().from(appsTable).where(eq(appsTable.id, PRJ_TOP))
  )[0]!;
  assert.equal(
    row.name,
    "renamed-top",
    "a top-level project is team-scoped only",
  );
});

test("the folder owner can act on a project inside their folder", async () => {
  await as(OWNER, async () => {
    await renameApp(PRJ_IN, "owner-renamed");
  });
  const row = (
    await db.select().from(appsTable).where(eq(appsTable.id, PRJ_IN))
  )[0]!;
  assert.equal(row.name, "owner-renamed");
});

test("a grantee with a folder grant can act; without it they can't", async () => {
  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, ["configure_apps"]));
  await as(GRANTEE, async () => {
    await renameApp(PRJ_IN, "grantee-renamed");
  });
  assert.equal(
    (await db.select().from(appsTable).where(eq(appsTable.id, PRJ_IN)))[0]!
      .name,
    "grantee-renamed",
  );

  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, []));
  await as(GRANTEE, async () => {
    await assert.rejects(
      () => renameApp(PRJ_IN, "grantee-again"),
      /not found|permission/i,
    );
  });
});

test("a grant EXCEEDS the grantee's team caps and holds (ADR-0016)", async () => {
  await as(OWNER, () =>
    setFolderGrant(FLD, GRANTEE, ["deploy_apps", "manage_backups"]),
  );
  const caps = await as(GRANTEE, () => folderCapabilities(FLD));
  assert.ok(caps.includes("deploy_apps"), "granted+held deploy_apps survives");
  assert.ok(
    caps.includes("manage_backups"),
    "a node grant replaces the team role inside the folder and may exceed it",
  );
  const teamCaps = await as(GRANTEE, () => currentCapabilities());
  assert.ok(
    !teamCaps.includes("manage_backups"),
    "the grant must not leak into the team-wide set",
  );
});

test("a grant can't exceed the GRANTER, and can't name a team-wide capability", async () => {
  await as(OWNER, () =>
    setFolderGrant(FLD, GRANTEE, ["manage_members", "deploy_apps"]),
  );
  const caps = await as(GRANTEE, () => folderCapabilities(FLD));
  assert.ok(caps.includes("deploy_apps"));
  assert.ok(
    !caps.includes("manage_members"),
    "a team-wide capability is never node-grantable",
  );
});

test("manage_infra: a member without folder access can't back up a project in the folder", async () => {
  await as(INFRA, async () => {
    await assert.rejects(
      () =>
        createBackup({
          name: "sneaky",
          targetKind: "app",
          databaseId: null,
          appId: PRJ_IN,
          destinationId: "s3_1",
          schedule: "0 3 * * *",
          retentionCount: 7,
        }),
      /not found|permission/i,
      "team manage_infra alone must not let a non-folder-member schedule a project backup",
    );
    await assert.rejects(
      () => runAppBackup(PRJ_IN, "s3_1"),
      /not found|permission/i,
      "ad-hoc project backup is folder-scoped too",
    );
  });
  assert.equal(
    (await db.select().from(foldersTable)).length,
    1,
    "no backup schedule row was created",
  );
});

test("manage_infra: the folder owner CAN back up a project inside their folder", async () => {
  const dto = await as(OWNER, () =>
    createBackup({
      name: "nightly",
      targetKind: "app",
      databaseId: null,
      appId: PRJ_IN,
      destinationId: "s3_1",
      schedule: "0 3 * * *",
      retentionCount: 7,
    }),
  );
  assert.equal(dto.targetKind, "app");
  await as(OWNER, () => deleteBackup(dto.id));
});

test("listFolders hides folders the caller can't see", async () => {
  const ownerFolders = await as(OWNER, () => listFolders());
  assert.deepEqual(
    ownerFolders.map((f) => f.id),
    [FLD],
  );

  const memberFolders = await as(MEMBER, () => listFolders());
  assert.deepEqual(
    memberFolders.map((f) => f.id),
    [],
    "a non-member of the folder sees none",
  );

  await as(OWNER, () => setFolderGrant(FLD, MEMBER, ["deploy_apps"]));
  const afterGrant = await as(MEMBER, () => listFolders());
  assert.deepEqual(
    afterGrant.map((f) => f.id),
    [FLD],
    "a grantee now sees the shared folder",
  );
});

const newAppIn = (folderId: string | null, name = "Made here") =>
  createApp({ name, source: "upload" as const, repo: null, folderId });

test("createApp files the new app IN the folder it was created from", async () => {
  const app = await as(OWNER, () => newAppIn(FLD));
  const row = (
    await db.select().from(appsTable).where(eq(appsTable.id, app.id))
  )[0]!;
  assert.equal(
    row.folderId,
    FLD,
    "an app created inside a folder must stay in it",
  );
  assert.equal(row.projectId, null, "one home only - no project link");
  assert.equal(row.environmentId, null);
  assert.equal(app.folderId, FLD);
});

test("createApp with no placement still lands at the top level", async () => {
  const app = await as(OWNER, () => newAppIn(null, "Top level"));
  const row = (
    await db.select().from(appsTable).where(eq(appsTable.id, app.id))
  )[0]!;
  assert.equal(row.folderId, null);
});

test("creating into a folder needs `create_apps` ON THAT FOLDER, not just at team level", async () => {
  await as(MEMBER, async () => {
    await assert.rejects(
      () => newAppIn(FLD, "Sneaky"),
      /not found|permission/i,
      "team-level create_apps alone must not create an app inside someone else's folder",
    );
  });
  const rows = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.folderId, FLD));
  assert.deepEqual(
    rows.map((r) => r.id),
    [PRJ_IN],
    "only the pre-seeded app is in the folder",
  );
});

test("a grantee with folder `create_apps` CAN create an app inside the folder", async () => {
  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, ["create_apps"]));
  const app = await as(GRANTEE, () => newAppIn(FLD, "Grantee app"));
  const row = (
    await db.select().from(appsTable).where(eq(appsTable.id, app.id))
  )[0]!;
  assert.equal(row.folderId, FLD);
});

test("createApp rejects an unknown folder id instead of silently creating top level", async () => {
  await as(OWNER, async () => {
    await assert.rejects(
      () => newAppIn("fld_does_not_exist", "Nowhere"),
      /folder not found/i,
    );
  });
  assert.equal(
    (await db.select().from(appsTable)).length,
    2,
    "only the two seeded apps exist - nothing was created",
  );
});

test("only the owner/super-user can administer grants; a grantee can't re-share", async () => {
  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, ["deploy_apps"]));
  await as(GRANTEE, async () => {
    await assert.rejects(
      () => listFolderGrants(FLD),
      /owner|not found|permission/i,
    );
    await assert.rejects(
      () => setFolderGrant(FLD, MEMBER, ["deploy_apps"]),
      /owner|not found|permission/i,
      "a grantee must never re-share the folder",
    );
  });
  const memberGrants = await db
    .select()
    .from(folderGrantsTable)
    .where(eq(folderGrantsTable.userId, MEMBER));
  assert.equal(memberGrants.length, 0);
});
