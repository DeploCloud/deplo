import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { runWithIdentity } from "../../auth/request-context";
import { __resetTestDb, __setTestDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { deployments } from "../../db/schema/control-plane/deployments";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import { folders as foldersTable } from "../../db/schema/control-plane/projects";
import {
  imageInventories,
  securityFindings,
  workloadImages,
} from "../../db/schema/control-plane/security-updates";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import {
  seedApp,
  seedDeployment,
  seedServer,
  SERVER_1,
} from "../app-graph-test-helpers";
import { seedIdentity, TEAM_A, TEAM_B } from "../identity-test-helpers";
import { appSecurityCounts, appSecurityUpdates } from "./read";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const OWNER = "u_owner";
const MEMBER = "u_member";
const STRANGER = "u_stranger";
const IMG = "sha256:" + "1".repeat(64);

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId }, fn);

async function seedFindings(appId: string, teamId: string) {
  await db
    .insert(imageInventories)
    .values({ imageId: IMG, status: "ok", scannedAt: T0 })
    .onConflictDoNothing();
  await db.insert(workloadImages).values({
    serverId: SERVER_1,
    workloadId: appId,
    service: "web",
    kind: "app",
    teamId,
    appId,
    imageRef: "deplo/x:1",
    imageId: IMG,
    running: true,
    seenAt: T0,
    checkedAt: T0,
  });
  const base = {
    serverId: SERVER_1,
    workloadId: appId,
    service: "web",
    ecosystem: "npm",
    installedVersion: "1",
    location: "/app/x",
    firstSeenAt: T0,
  };
  await db.insert(securityFindings).values([
    {
      ...base,
      vulnId: "GHSA-a",
      packageName: "a",
      fixedVersion: "2",
      level: "critical",
      fix: "code",
    },
    {
      ...base,
      vulnId: "GHSA-b",
      packageName: "b",
      fixedVersion: "2",
      level: "high",
      fix: "code",
    },
    {
      ...base,
      vulnId: "GHSA-c",
      packageName: "c",
      fixedVersion: "2",
      level: "exploited",
      fix: "code",
    },
    {
      ...base,
      vulnId: "DEBIAN-CVE-1",
      ecosystem: "Debian:12",
      packageName: "openssl",
      fixedVersion: "3.0.15",
      level: "exploited",
      fix: "rebuild",
      location: "/var/lib/dpkg/status",
    },
    {
      ...base,
      vulnId: "GO-1",
      ecosystem: "Go",
      packageName: "stdlib",
      fixedVersion: "1.24.0",
      level: "critical",
      fix: "code",
      location: "/app/node_modules/@esbuild/linux-x64/bin/esbuild",
    },
  ]);
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table security_findings, workload_images, image_inventories,
    folder_grants, app_build_method_settings, app_build, apps, folders, servers,
    membership_capabilities, memberships, users, teams, instance_settings restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      {
        id: MEMBER,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view"],
      },
      { id: STRANGER, teamId: TEAM_B, role: "owner" },
    ],
  });
  await db
    .insert(instanceSettings)
    .values({ id: "default", updatedAt: T0 })
    .onConflictDoNothing();
  await seedServer(db);
  await seedApp(db, { id: "prj_web", teamId: TEAM_A });
  await seedFindings("prj_web", TEAM_A);
});

test("the team sees its own dependencies' updates, counted ones first; Important ones are listed only", async () => {
  const s = await as(OWNER, TEAM_A, () => appSecurityUpdates("prj_web"));
  assert.ok(s);
  assert.deepEqual(
    s.updates.map((u) => `${u.packageName}:${u.actionable}`),
    ["c:true", "a:true", "b:false"],
  );
  assert.equal(s.count, 2);
  assert.equal(s.exploited, 1);
  assert.equal(s.checkedAt, T0);
  const counts = await as(OWNER, TEAM_A, () => appSecurityCounts(["prj_web"]));
  assert.deepEqual(counts.get("prj_web"), { count: 2, exploited: 1 });
});

test("another team's app answers nothing, by id or by count", async () => {
  assert.equal(
    await as(STRANGER, TEAM_B, () => appSecurityUpdates("prj_web")),
    null,
  );
  const counts = await as(STRANGER, TEAM_B, () =>
    appSecurityCounts(["prj_web"]),
  );
  assert.equal(counts.size, 0);
});

test("an app in a folder the member was never granted is out of reach", async () => {
  await db.insert(foldersTable).values({
    id: "fld_x",
    teamId: TEAM_A,
    name: "Private",
    parentId: null,
    color: null,
    ownerUserId: OWNER,
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .update(appsTable)
    .set({ folderId: "fld_x" })
    .where(eq(appsTable.id, "prj_web"));
  const owner = await as(OWNER, TEAM_A, () => appSecurityUpdates("prj_web"));
  assert.ok(owner, "the owner still sees it");
  const member = await as(MEMBER, TEAM_A, () => appSecurityUpdates("prj_web"));
  assert.equal(member, null);
});

test("with the instance switch off nothing is answered", async () => {
  await db.update(instanceSettings).set({ securityUpdatesEnabled: false });
  assert.equal(
    await as(OWNER, TEAM_A, () => appSecurityUpdates("prj_web")),
    null,
  );
  const counts = await as(OWNER, TEAM_A, () => appSecurityCounts(["prj_web"]));
  assert.equal(counts.size, 0);
});

test("a deploy that went live after the last check hides the old image's updates", async () => {
  await seedDeployment(db, { id: "dpl_new", appId: "prj_web" });
  await db
    .update(deployments)
    .set({ readyAt: "2026-01-01T01:00:00.000Z" })
    .where(eq(deployments.id, "dpl_new"));
  const s = await as(OWNER, TEAM_A, () => appSecurityUpdates("prj_web"));
  assert.equal(s!.checking, true);
  assert.equal(
    s!.updates.length,
    0,
    "the old image's findings are not this deploy's",
  );
  assert.equal(s!.count, 0);
  const counts = await as(OWNER, TEAM_A, () => appSecurityCounts(["prj_web"]));
  assert.equal(counts.size, 0);

  await db.update(workloadImages).set({ seenAt: "2026-01-01T01:05:00.000Z" });
  const listed = await as(OWNER, TEAM_A, () => appSecurityUpdates("prj_web"));
  assert.equal(
    listed!.checking,
    false,
    "listed again, same image: nothing to read",
  );
  assert.equal(listed!.count, 2);
});

test("an image that changed and was not matched yet is being checked", async () => {
  await db.update(workloadImages).set({ checkedAt: null });
  const s = await as(OWNER, TEAM_A, () => appSecurityUpdates("prj_web"));
  assert.equal(s!.checking, true);
  assert.equal(s!.updates.length, 0);
});
