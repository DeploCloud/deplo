import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  folders as foldersTable,
  folderGrants as folderGrantsTable,
  apps as appsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { seedS3 } from "./backup-test-helpers";
import { renameApp } from "./apps";
import { createBackup, runAppBackup, deleteBackup } from "./backups";
import {
  folderCapabilities,
  setFolderGrant,
  listFolderGrants,
} from "./folder-access";
import { listFolders } from "./folders";

/**
 * End-to-end authorization tests for the per-folder access model against pglite
 * — the DB-backed twin of the pure-math unit tests in folder-access.test.ts.
 * These prove the load-bearing rule the whole feature exists for: holding a TEAM
 * capability is NOT enough to act on a project inside a folder — you also need
 * that capability ON THE FOLDER (owner, grant, or super-user). Top-level apps
 * stay team-only.
 *
 * Cast of users (all in TEAM_A):
 *  - OWNER   — team owner (all caps) + folder owner. Super-user via manage_team.
 *  - MEMBER  — full member caps (deploy/domains/env/files) but NO folder access.
 *  - GRANTEE — same member caps; granted `deploy` on the folder by the owner.
 *  - INFRA   — a custom member holding manage_infra but no folder access.
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
    folder_grants, backup_runs, backups, s3_destination,
    app_build_method_settings, app_build, apps, folders, servers,
    membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      // OWNER is the team owner (isInstanceAdmin defaults true for owners, but the
      // folder rules exercise the manage_team super-user path all the same).
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      {
        id: MEMBER,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "deploy", "manage_domains", "manage_env", "manage_files"],
      },
      {
        id: GRANTEE,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "deploy", "manage_domains", "manage_env", "manage_files"],
      },
      {
        id: INFRA,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "manage_infra"],
      },
    ],
  });
  await seedServer(db);
  await seedS3(db, { id: "s3_1" });
  // A folder OWNED by OWNER, and a project inside it + one at the top level.
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
  // Move PRJ_IN into the folder (seedApp seeds folderId=null).
  await db
    .update(appsTable)
    .set({ folderId: FLD })
    .where(eq(appsTable.id, PRJ_IN));
});

test("a team member without folder access can't act on a project inside the folder", async () => {
  // MEMBER holds team `deploy` but no access to FLD → renaming PRJ_IN is blocked.
  await as(MEMBER, async () => {
    await assert.rejects(
      () => renameApp(PRJ_IN, "hijacked"),
      /not found|permission/i,
      "team deploy alone must NOT let a non-folder-member rename a project in the folder",
    );
  });
  // The rename never happened.
  const row = (await db.select().from(appsTable).where(eq(appsTable.id, PRJ_IN)))[0]!;
  assert.equal(row.name, PRJ_IN, "project name unchanged after the blocked rename");
});

test("the same member CAN act on a TOP-LEVEL project (team caps govern)", async () => {
  await as(MEMBER, async () => {
    await renameApp(PRJ_TOP, "renamed-top");
  });
  const row = (await db.select().from(appsTable).where(eq(appsTable.id, PRJ_TOP)))[0]!;
  assert.equal(row.name, "renamed-top", "a top-level project is team-scoped only");
});

test("the folder owner can act on a project inside their folder", async () => {
  await as(OWNER, async () => {
    await renameApp(PRJ_IN, "owner-renamed");
  });
  const row = (await db.select().from(appsTable).where(eq(appsTable.id, PRJ_IN)))[0]!;
  assert.equal(row.name, "owner-renamed");
});

test("a grantee with folder `deploy` can act; without it they can't", async () => {
  // Owner shares the folder with GRANTEE, granting deploy.
  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, ["deploy"]));
  await as(GRANTEE, async () => {
    await renameApp(PRJ_IN, "grantee-renamed");
  });
  assert.equal(
    (await db.select().from(appsTable).where(eq(appsTable.id, PRJ_IN)))[0]!.name,
    "grantee-renamed",
  );

  // Revoke the folder grant → the grantee loses the ability again.
  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, []));
  await as(GRANTEE, async () => {
    await assert.rejects(
      () => renameApp(PRJ_IN, "grantee-again"),
      /not found|permission/i,
    );
  });
});

test("a grant is bounded by the grantee's team caps and can't exceed the granter", async () => {
  // GRANTEE has no team manage_infra, so granting it is a no-op (bounded away):
  // their effective folder caps must not include manage_infra.
  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, ["deploy", "manage_infra"]));
  const caps = await as(GRANTEE, () => folderCapabilities(FLD));
  assert.ok(caps.includes("deploy"), "granted+held deploy survives");
  assert.ok(
    !caps.includes("manage_infra"),
    "manage_infra can't be granted to a user who lacks it at team level",
  );
});

test("manage_infra: a member without folder access can't back up a project in the folder", async () => {
  // INFRA holds team manage_infra but no folder access. Creating a project-target
  // backup schedule for PRJ_IN, and the ad-hoc run, are both blocked.
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
          retentionDays: 7,
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
  // OWNER owns the folder; but the OWNER user was seeded as team owner whose caps
  // include manage_infra, so they pass both gates.
  const dto = await as(OWNER, () =>
    createBackup({
      name: "nightly",
      targetKind: "app",
      databaseId: null,
      appId: PRJ_IN,
      destinationId: "s3_1",
      schedule: "0 3 * * *",
      retentionDays: 7,
    }),
  );
  assert.equal(dto.targetKind, "app");
  // And deleting it is likewise allowed for the owner.
  await as(OWNER, () => deleteBackup(dto.id));
});

test("listFolders hides folders the caller can't see", async () => {
  // OWNER sees their folder; MEMBER (no access) sees nothing; a super-user sees all.
  const ownerFolders = await as(OWNER, () => listFolders());
  assert.deepEqual(ownerFolders.map((f) => f.id), [FLD]);

  const memberFolders = await as(MEMBER, () => listFolders());
  assert.deepEqual(memberFolders.map((f) => f.id), [], "a non-member of the folder sees none");

  // Grant MEMBER view access → the folder appears for them.
  await as(OWNER, () => setFolderGrant(FLD, MEMBER, ["deploy"]));
  const afterGrant = await as(MEMBER, () => listFolders());
  assert.deepEqual(afterGrant.map((f) => f.id), [FLD], "a grantee now sees the shared folder");
});

test("only the owner/super-user can administer grants; a grantee can't re-share", async () => {
  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, ["deploy"]));
  // GRANTEE, even with folder deploy, cannot list or hand out grants.
  await as(GRANTEE, async () => {
    await assert.rejects(() => listFolderGrants(FLD), /owner|not found|permission/i);
    await assert.rejects(
      () => setFolderGrant(FLD, MEMBER, ["deploy"]),
      /owner|not found|permission/i,
      "a grantee must never re-share the folder",
    );
  });
  // No grant to MEMBER leaked through.
  const memberGrants = await db
    .select()
    .from(folderGrantsTable)
    .where(eq(folderGrantsTable.userId, MEMBER));
  assert.equal(memberGrants.length, 0);
});
