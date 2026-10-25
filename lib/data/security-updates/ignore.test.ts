import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { runWithIdentity } from "../../auth/request-context";
import { __resetTestDb, __setTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import { folders as foldersTable } from "../../db/schema/control-plane/projects";
import {
  imageInventories,
  securityFindings,
  securityIgnores,
  workloadImages,
} from "../../db/schema/control-plane/security-updates";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { seedApp, seedServer, SERVER_1 } from "../app-graph-test-helpers";
import { setFolderGrant } from "../folder-access";
import { seedIdentity, TEAM_A, TEAM_B } from "../identity-test-helpers";
import { ignoreSecurityUpdate, unignoreSecurityUpdate } from "./ignore";
import { appSecurityCounts, appSecurityUpdates } from "./read";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const OWNER = "u_owner";
const MEMBER = "u_member";
const GRANTEE = "u_grantee";
const STRANGER = "u_stranger";
const IMG = "sha256:" + "1".repeat(64);
const VULNS = ["DEBIAN-CVE-1", "DEBIAN-CVE-2"];

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table security_ignores, security_findings, workload_images, image_inventories,
    activities, folder_grants, app_build_method_settings, app_build, apps, folders, servers,
    membership_capabilities, memberships, users, teams, instance_settings restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      {
        id: MEMBER,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "deploy_apps"],
      },
      {
        id: GRANTEE,
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
  await db
    .insert(imageInventories)
    .values({ imageId: IMG, status: "ok", scannedAt: T0 });
  await db.insert(workloadImages).values({
    serverId: SERVER_1,
    workloadId: "prj_web",
    service: "web",
    kind: "app",
    teamId: TEAM_A,
    appId: "prj_web",
    imageRef: "deplo/x:1",
    imageId: IMG,
    running: true,
    seenAt: T0,
    checkedAt: T0,
  });
  await db.insert(securityFindings).values(
    VULNS.map((vulnId) => ({
      serverId: SERVER_1,
      workloadId: "prj_web",
      service: "web",
      vulnId,
      ecosystem: "npm",
      packageName: "openssl",
      installedVersion: "3.0.11",
      fixedVersion: "3.0.15",
      level: "critical",
      fix: "code",
      location: "/app/node_modules/openssl/package.json",
      firstSeenAt: T0,
    })),
  );
});

test("ignoring a package takes it out of the count until it expires, and Activity names who", async () => {
  await as(OWNER, TEAM_A, () =>
    ignoreSecurityUpdate({
      appId: "prj_web",
      vulnIds: VULNS,
      reason: "not exposed",
      days: 30,
    }),
  );
  const s = await as(OWNER, TEAM_A, () => appSecurityUpdates("prj_web"));
  assert.equal(s!.count, 0);
  assert.ok(
    s!.updates.every((u) => u.ignored && u.ignoreReason === "not exposed"),
  );
  assert.equal(
    (await as(OWNER, TEAM_A, () => appSecurityCounts(["prj_web"]))).size,
    0,
  );

  const [act] = await db.select().from(activities);
  assert.match(
    act.message,
    /^Ignored the openssl security update in prj_web until \d{4}-\d{2}-\d{2}: not exposed$/,
  );
  assert.equal(act.actor, OWNER);

  await db.update(securityIgnores).set({ expiresAt: T0 });
  const later = await as(OWNER, TEAM_A, () => appSecurityUpdates("prj_web"));
  assert.equal(later!.count, 1, "an expired ignore counts again");
});

test("stop ignoring brings it back and is recorded", async () => {
  await as(OWNER, TEAM_A, () =>
    ignoreSecurityUpdate({ appId: "prj_web", vulnIds: VULNS }),
  );
  await as(OWNER, TEAM_A, () =>
    unignoreSecurityUpdate({ appId: "prj_web", vulnIds: VULNS }),
  );
  assert.equal(
    (await as(OWNER, TEAM_A, () => appSecurityUpdates("prj_web")))!.count,
    1,
  );
  const msgs = (await db.select().from(activities)).map((a) => a.message);
  assert.ok(
    msgs.includes("Stopped ignoring the openssl security update in prj_web"),
    msgs.join(" | "),
  );
});

test("a member without the Capability and another team are refused", async () => {
  await assert.rejects(
    as(MEMBER, TEAM_A, () =>
      ignoreSecurityUpdate({ appId: "prj_web", vulnIds: VULNS }),
    ),
    /permission/,
  );
  await assert.rejects(
    as(STRANGER, TEAM_B, () =>
      ignoreSecurityUpdate({ appId: "prj_web", vulnIds: VULNS }),
    ),
  );
  assert.equal((await db.select().from(securityIgnores)).length, 0);
});

test("a folder grant carries the Capability into that folder only", async () => {
  await db.insert(foldersTable).values({
    id: "fld_x",
    teamId: TEAM_A,
    name: "Payments",
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
  await assert.rejects(
    as(GRANTEE, TEAM_A, () =>
      ignoreSecurityUpdate({ appId: "prj_web", vulnIds: VULNS }),
    ),
  );
  await as(OWNER, TEAM_A, () =>
    setFolderGrant("fld_x", GRANTEE, ["view", "ignore_security_updates"]),
  );
  await as(GRANTEE, TEAM_A, () =>
    ignoreSecurityUpdate({ appId: "prj_web", vulnIds: VULNS }),
  );
  assert.equal((await db.select().from(securityIgnores)).length, 2);
});

test("bad input is refused", async () => {
  await assert.rejects(
    as(OWNER, TEAM_A, () =>
      ignoreSecurityUpdate({ appId: "prj_web", vulnIds: [] }),
    ),
  );
  await assert.rejects(
    as(OWNER, TEAM_A, () =>
      ignoreSecurityUpdate({ appId: "prj_web", vulnIds: ["not an id!"] }),
    ),
  );
  await assert.rejects(
    as(OWNER, TEAM_A, () =>
      ignoreSecurityUpdate({ appId: "prj_web", vulnIds: VULNS, days: 7 }),
    ),
  );
});
