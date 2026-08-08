import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedS3, seedBackup } from "./backup-test-helpers";
import {
  activities as activitiesTable,
  apps as appsTable,
  backups as backupsTable,
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  servers as serversTable,
  serverTeams as serverTeamsTable,
  sharedEnvVarApps as sharedEnvVarAppsTable,
  sharedEnvVars as sharedEnvVarsTable,
  teamAppOrder,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { createFolder } from "./folders";
import { appTransferInfo, transferAppToTeam } from "./app-transfer";
import type { Capability } from "../types";

/**
 * Data-layer tests for transferring an App to another team (Advanced → Danger
 * Zone). What they pin down is the tenancy contract, not the row update: the
 * destination has to be a team the CALLER belongs to with `deploy`, the caller
 * needs `manage_env` here (the app carries its secrets across), the app may not
 * land on a server that team can't target, and every attachment to the source
 * team — folder, shared-variable links, backup schedules, display order,
 * activity pointers, a GitHub installation it doesn't own — is severed.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const APP = "prj_app";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => asUser(USER_1, fn);

/** Add an EXISTING user to another team with a capability set. */
async function joinTeam(
  userId: string,
  teamId: string,
  capabilities: Capability[],
): Promise<void> {
  const id = `mem_${userId}_${teamId}`;
  await db
    .insert(membershipsTable)
    .values({ id, userId, teamId, role: "member", createdAt: T0 });
  if (capabilities.length > 0)
    await db
      .insert(membershipCapabilitiesTable)
      .values(capabilities.map((capability) => ({ membershipId: id, capability })));
}

/** A GitHub App owned by `teamId` with one installation on `accountLogin`. */
async function seedGithub(
  teamId: string,
  accountLogin: string,
  ids: { app: string; install: string; numeric: number },
): Promise<string> {
  await db.insert(githubAppsTable).values({
    id: ids.app,
    teamId,
    appId: ids.numeric,
    slug: ids.app,
    name: ids.app,
    clientId: "cid",
    clientSecretEnc: "x",
    webhookSecretEnc: "x",
    privateKeyEnc: "x",
    htmlUrl: "https://github.com/apps/x",
    createdAt: T0,
  });
  await db.insert(githubInstallationTable).values({
    id: ids.install,
    appId: ids.app,
    installationId: ids.numeric,
    accountLogin,
    accountType: "Organization",
    avatarUrl: "https://x",
    createdAt: T0,
  });
  return ids.install;
}

const appRow = async () =>
  (
    await db
      .select({
        teamId: appsTable.teamId,
        folderId: appsTable.folderId,
        autoDeploy: appsTable.autoDeploy,
        repoInstallationId: appsTable.repoInstallationId,
      })
      .from(appsTable)
      .where(eq(appsTable.id, APP))
      .limit(1)
  )[0];

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table activities, backup_runs, backups, backup_destination restart identity cascade;
    truncate table github_installation, github_apps restart identity cascade;
    truncate table registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      // A deployer WITHOUT manage_env — the source-side secret gate.
      { id: "user_2", teamId: TEAM_A, capabilities: ["view", "move_apps", "create_apps"] },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A });
});

test("transfers the app, and severs every tie to the team it came from", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_apps", "create_apps", "manage_env"]);
  const dest = await seedS3(db, { id: "s3_1", teamId: TEAM_A });
  await seedBackup(db, {
    id: "bkp_1",
    teamId: TEAM_A,
    targetKind: "app",
    appId: APP,
    destinationId: dest,
  });
  await db.insert(sharedEnvVarsTable).values({
    id: "svar_1",
    teamId: TEAM_A,
    key: "SHARED",
    valueEnc: "x",
    type: "plain",
    teamWide: false,
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .insert(sharedEnvVarAppsTable)
    .values({ varId: "svar_1", appId: APP });
  await db
    .insert(teamAppOrder)
    .values({ teamId: TEAM_A, appId: APP, position: 0 });
  await db.insert(activitiesTable).values({
    id: "act_1",
    teamId: TEAM_A,
    type: "app",
    message: "Deployed",
    actor: USER_1,
    appId: APP,
    createdAt: T0,
  });

  await asOwner(async () => {
    const { appGrants: agTable, teamRoles: trTable, teamRoleScopeApps: trsTable } =
      await import("../db/schema/control-plane");
    await db
      .insert(agTable)
      .values({ appId: APP, userId: USER_1, capability: "manage_env" });
    await db.insert(trTable).values({
      id: "role_src", teamId: TEAM_A, builtinKey: null, name: "Src",
      description: null, requireTwoFactor: false, scoped: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await db.insert(trsTable).values({ roleId: "role_src", appId: APP });

    const folder = await createFolder("Marketing");
    await db
      .update(appsTable)
      .set({ folderId: folder.id })
      .where(eq(appsTable.id, APP));
    await transferAppToTeam(APP, TEAM_B);
  });

  const row = await appRow();
  assert.equal(row.teamId, TEAM_B, "the app now belongs to the destination team");
  assert.equal(row.folderId, null, "it left the source team's folder");
  // Per-node access is a fact about the team it came FROM: a grant that
  // travelled would hand a destination member capabilities their own team never
  // voted on, and a scope row would limit a source-team role to an app that is
  // no longer in it.
  const { appGrants, teamRoleScopeApps } = await import(
    "../db/schema/control-plane"
  );
  assert.equal(
    (await db.select().from(appGrants).where(eq(appGrants.appId, APP))).length,
    0,
    "a per-app grant travelled with the app",
  );
  assert.equal(
    (
      await db
        .select()
        .from(teamRoleScopeApps)
        .where(eq(teamRoleScopeApps.appId, APP))
    ).length,
    0,
    "a role scope row travelled with the app",
  );
  assert.equal(
    (await db.select().from(backupsTable).where(eq(backupsTable.appId, APP))).length,
    0,
    "backup schedules pointing at the source team's storage are gone",
  );
  assert.equal(
    (
      await db
        .select()
        .from(sharedEnvVarAppsTable)
        .where(eq(sharedEnvVarAppsTable.appId, APP))
    ).length,
    0,
    "shared-variable links do not travel",
  );
  assert.equal(
    (await db.select().from(teamAppOrder).where(eq(teamAppOrder.appId, APP))).length,
    0,
    "the source team's display order no longer lists it",
  );
  const oldActivity = (
    await db
      .select({ appId: activitiesTable.appId, teamId: activitiesTable.teamId })
      .from(activitiesTable)
      .where(eq(activitiesTable.id, "act_1"))
  )[0];
  assert.equal(oldActivity.teamId, TEAM_A, "history stays with the source team");
  assert.equal(oldActivity.appId, null, "but stops pointing at the app");
  const received = await db
    .select({ message: activitiesTable.message })
    .from(activitiesTable)
    .where(eq(activitiesTable.teamId, TEAM_B));
  assert.ok(
    received.some((a) => /^Received /.test(a.message)),
    "the destination team is told it received the app",
  );
});

test("refuses a team the caller doesn't belong to, or can't deploy in", async () => {
  await asOwner(async () => {
    await assert.rejects(
      transferAppToTeam(APP, TEAM_B),
      /not a member of that team/i,
    );
  });
  await joinTeam(USER_1, TEAM_B, ["view"]);
  await asOwner(async () => {
    await assert.rejects(
      transferAppToTeam(APP, TEAM_B),
      /permission to manage apps in that team/i,
    );
  });
});

test("refuses a caller who may deploy here but not read the variables", async () => {
  await joinTeam("user_2", TEAM_B, ["view", "move_apps", "create_apps", "manage_env"]);
  await asUser("user_2", async () => {
    await assert.rejects(transferAppToTeam(APP, TEAM_B), /permission/i);
  });
  assert.equal((await appRow()).teamId, TEAM_A);
});

test("refuses to strand the app on a server the destination team can't target", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_apps", "create_apps", "manage_env"]);
  await db
    .update(serversTable)
    .set({ allTeams: false })
    .where(eq(serversTable.id, SERVER_1));
  await db
    .insert(serverTeamsTable)
    .values({ serverId: SERVER_1, teamId: TEAM_A });

  await asOwner(async () => {
    const info = await appTransferInfo(APP);
    assert.equal(info.targets.length, 1);
    assert.equal(info.targets[0].serverAvailable, false);
    await assert.rejects(transferAppToTeam(APP, TEAM_B), /can't use the server/i);
  });
  assert.equal((await appRow()).teamId, TEAM_A);

  // Grant the destination team access and it goes through.
  await db
    .insert(serverTeamsTable)
    .values({ serverId: SERVER_1, teamId: TEAM_B });
  await asOwner(() => transferAppToTeam(APP, TEAM_B));
  assert.equal((await appRow()).teamId, TEAM_B);
});

test("a foreign app id is not found, and its team is never touched", async () => {
  await db.insert(teamsTable).values({
    id: "team_c",
    name: "gamma",
    slug: "gamma",
    plan: "pro",
    founderUserId: null,
    createdAt: T0,
  });
  await seedApp(db, { id: "prj_other", teamId: TEAM_B, slug: "other" });
  await joinTeam(USER_1, TEAM_B, ["view", "move_apps", "create_apps", "manage_env"]);
  await asOwner(async () => {
    await assert.rejects(
      transferAppToTeam("prj_other", TEAM_B),
      /App not found/i,
    );
  });
});

test("the GitHub connection is dropped unless the destination owns one on that account", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_apps", "create_apps", "manage_env"]);
  const sourceInstall = await seedGithub(TEAM_A, "acme", {
    app: "gha_a",
    install: "ghi_a",
    numeric: 111,
  });
  await db
    .update(appsTable)
    .set({ repoRepo: "acme/site", repoInstallationId: sourceInstall })
    .where(eq(appsTable.id, APP));

  await asOwner(async () => {
    const info = await appTransferInfo(APP);
    assert.equal(info.githubConnected, true);
    assert.equal(
      info.targets[0].githubFollows,
      false,
      "the destination has no GitHub App on that account yet",
    );
    await transferAppToTeam(APP, TEAM_B);
  });
  const dropped = await appRow();
  assert.equal(dropped.repoInstallationId, null, "the source team's credential does not travel");
  assert.equal(dropped.autoDeploy, false, "auto-deploy can no longer fire, so it is turned off");
});

test("the GitHub connection follows when the destination has its own installation", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_apps", "create_apps", "manage_env"]);
  const sourceInstall = await seedGithub(TEAM_A, "acme", {
    app: "gha_a",
    install: "ghi_a",
    numeric: 111,
  });
  const destInstall = await seedGithub(TEAM_B, "Acme", {
    app: "gha_b",
    install: "ghi_b",
    numeric: 222,
  });
  await db
    .update(appsTable)
    .set({ repoRepo: "acme/site", repoInstallationId: sourceInstall })
    .where(eq(appsTable.id, APP));

  await asOwner(async () => {
    assert.equal((await appTransferInfo(APP)).targets[0].githubFollows, true);
    await transferAppToTeam(APP, TEAM_B);
  });
  const row = await appRow();
  assert.equal(
    row.repoInstallationId,
    destInstall,
    "it re-points at the destination team's own installation, matched case-insensitively",
  );
  assert.equal(row.autoDeploy, true, "auto-deploy keeps working");
});

test("appTransferInfo offers only the viewer's OTHER teams that can deploy", async () => {
  await db.insert(teamsTable).values({
    id: "team_c",
    name: "gamma",
    slug: "gamma",
    plan: "pro",
    founderUserId: null,
    createdAt: T0,
  });
  await joinTeam(USER_1, TEAM_B, ["view", "move_apps", "create_apps"]);
  await joinTeam(USER_1, "team_c", ["view"]);

  await asOwner(async () => {
    const info = await appTransferInfo(APP);
    assert.deepEqual(
      info.targets.map((t) => t.id),
      [TEAM_B],
      "the active team, and a team without deploy, are not offered",
    );
    assert.equal(info.homeLabel, null);
    assert.equal(info.sharedVarCount, 0);
    assert.equal(info.backupCount, 0);
    assert.equal(info.githubConnected, false);
    assert.equal(
      info.targets[0].githubFollows,
      true,
      "an app with no GitHub connection has nothing to lose",
    );
  });
});

test("a transfer into the app's own team is refused", async () => {
  await asOwner(async () => {
    await assert.rejects(transferAppToTeam(APP, TEAM_A), /already in this team/i);
  });
});

test("only the app's own team may transfer it", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_apps", "create_apps", "manage_env"]);
  await asOwner(() => transferAppToTeam(APP, TEAM_B));
  // The app is TEAM_B's now: acting as TEAM_A, it is invisible again.
  await asOwner(async () => {
    await assert.rejects(appTransferInfo(APP), /App not found/i);
    await assert.rejects(transferAppToTeam(APP, TEAM_B), /App not found/i);
  });
  const still = await db
    .select({ teamId: appsTable.teamId })
    .from(appsTable)
    .where(and(eq(appsTable.id, APP), eq(appsTable.teamId, TEAM_B)));
  assert.equal(still.length, 1);
});
