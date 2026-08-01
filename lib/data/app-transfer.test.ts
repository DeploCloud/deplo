import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  activities as activitiesTable,
  appEnvironments as appEnvironmentsTable,
  apps as appsTable,
  backups as backupsTable,
  environments as environmentsTable,
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
  membershipCapabilities as membershipCapabilitiesTable,
  memberships as membershipsTable,
  projects as projectsTable,
  serverTeams as serverTeamsTable,
  servers as serversTable,
  sharedEnvVarApps as sharedEnvVarAppsTable,
  sharedEnvVars as sharedEnvVarsTable,
  teamAppOrder,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, seedApp, SERVER_1 } from "./app-graph-test-helpers";
import { seedS3, seedBackup } from "./backup-test-helpers";
import { encryptSecret } from "../crypto";
import { capabilitiesForRole } from "../membership-shared";
import { appTransferInfo, transferAppToTeam } from "./app-transfer";
import type { Capability } from "../types";

/**
 * Integration tests for handing an App to another team, against pglite.
 *
 * The transfer is the one write that crosses the tenancy boundary, so these
 * prove BOTH halves of it: what must travel with the app (the row itself, its
 * own children) and what must be cut because it belongs to the old team — the
 * folder/project placement, shared-variable links, backup schedules, the
 * Overview order, and the team-owned GitHub installation. Plus the gates: the
 * source needs `deploy` + `manage_env`, the destination has to be a team the
 * caller can deploy in, and the app's server has to be targetable there.
 */

let db: TestDb;
let pg: PGlite;

const TEAM_C = "team_c";
const APP = "prj_transfer";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** A second (or third) membership for the same user — seedIdentity mints one. */
async function joinTeam(
  teamId: string,
  capabilities: Capability[],
): Promise<void> {
  const membershipId = `mem_${USER_1}_${teamId}`;
  await db.insert(membershipsTable).values({
    id: membershipId,
    userId: USER_1,
    teamId,
    role: "member",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  if (capabilities.length > 0)
    await db
      .insert(membershipCapabilitiesTable)
      .values(capabilities.map((c) => ({ membershipId, capability: c })));
}

/** A team-owned GitHub App with one installation for `accountLogin`. */
async function seedGithub(
  teamId: string,
  accountLogin: string,
  numericId: number,
): Promise<string> {
  const appDbId = `gha_${teamId}`;
  const installId = `ghi_${teamId}`;
  await db.insert(githubAppsTable).values({
    id: appDbId,
    teamId,
    appId: numericId,
    slug: `deplo-${teamId}`,
    name: `Deplo ${teamId}`,
    clientId: "Iv1.test",
    clientSecretEnc: encryptSecret("cs"),
    webhookSecretEnc: encryptSecret("ws"),
    privateKeyEnc: encryptSecret("pk"),
    htmlUrl: "https://github.com/apps/x",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(githubInstallationTable).values({
    id: installId,
    appId: appDbId,
    installationId: numericId + 1000,
    accountLogin,
    accountType: "Organization",
    avatarUrl: "https://x",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return installId;
}

beforeEach(async () => {
  await pg.query(`truncate table
    shared_env_var_apps, shared_env_vars,
    backup_runs, backups, s3_destination,
    github_installation, github_apps,
    activities, app_environments, environments, team_project_order, projects,
    team_app_order, folders, apps, server_teams, servers,
    membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
      { id: TEAM_C, slug: "gamma" },
    ],
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  // Beta can take an app (deploy); gamma can only look (view).
  await joinTeam(TEAM_B, capabilitiesForRole("member"));
  await joinTeam(TEAM_C, ["view"]);
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A });
});

const appRow = async () =>
  (
    await db
      .select({
        teamId: appsTable.teamId,
        folderId: appsTable.folderId,
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
        repoInstallationId: appsTable.repoInstallationId,
        autoDeploy: appsTable.autoDeploy,
      })
      .from(appsTable)
      .where(eq(appsTable.id, APP))
      .limit(1)
  )[0];

test("transfer hands the app over and cuts everything the old team owns", async () => {
  // The app sits in a project environment, is linked to a shared variable, has a
  // backup schedule, a manual Overview position and an activity row.
  await db.insert(projectsTable).values({
    id: "prc_1",
    teamId: TEAM_A,
    name: "Shop",
    slug: "shop",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(environmentsTable).values({
    id: "environ_1",
    projectId: "prc_1",
    name: "production",
    slug: "production",
    kind: "production",
    isDefault: true,
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await db
    .update(appsTable)
    .set({ projectId: "prc_1", environmentId: "environ_1" })
    .where(eq(appsTable.id, APP));
  await db.insert(appEnvironmentsTable).values({
    appId: APP,
    environmentId: "environ_1",
    status: "active",
    url: "https://x",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(sharedEnvVarsTable).values({
    id: "sev_1",
    teamId: TEAM_A,
    key: "SHARED",
    valueEnc: encryptSecret("v"),
    type: "plain",
    teamWide: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await db
    .insert(sharedEnvVarAppsTable)
    .values({ varId: "sev_1", appId: APP });
  await seedS3(db, { id: "s3_1", teamId: TEAM_A });
  await seedBackup(db, {
    id: "bkp_1",
    teamId: TEAM_A,
    destinationId: "s3_1",
    targetKind: "app",
    appId: APP,
  });
  await db
    .insert(teamAppOrder)
    .values({ teamId: TEAM_A, appId: APP, position: 0 });
  await db.insert(activitiesTable).values({
    id: "act_1",
    teamId: TEAM_A,
    type: "app",
    message: "Deployed it",
    actor: USER_1,
    appId: APP,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  await asOwner(() => transferAppToTeam(APP, TEAM_B));

  const app = await appRow();
  assert.equal(app.teamId, TEAM_B);
  // Placement belongs to the old team: the app lands at the top level.
  assert.equal(app.projectId, null);
  assert.equal(app.environmentId, null);
  assert.equal(app.folderId, null);

  const envRows = await db
    .select()
    .from(appEnvironmentsTable)
    .where(eq(appEnvironmentsTable.appId, APP));
  assert.equal(envRows.length, 0);
  const links = await db
    .select()
    .from(sharedEnvVarAppsTable)
    .where(eq(sharedEnvVarAppsTable.appId, APP));
  assert.equal(links.length, 0);
  const schedules = await db
    .select()
    .from(backupsTable)
    .where(eq(backupsTable.appId, APP));
  assert.equal(schedules.length, 0);
  const order = await db
    .select()
    .from(teamAppOrder)
    .where(eq(teamAppOrder.appId, APP));
  assert.equal(order.length, 0);

  // The old team keeps its history; the pointer into an app it can no longer
  // open is dropped.
  const old = (
    await db
      .select({ appId: activitiesTable.appId, message: activitiesTable.message })
      .from(activitiesTable)
      .where(eq(activitiesTable.id, "act_1"))
  )[0];
  assert.equal(old.appId, null);
  assert.equal(old.message, "Deployed it");

  // One audit row per side.
  const sourceLog = await db
    .select({ message: activitiesTable.message })
    .from(activitiesTable)
    .where(eq(activitiesTable.teamId, TEAM_A));
  assert.ok(
    sourceLog.some((r) => r.message.startsWith(`Transferred ${APP} to beta`)),
    `expected a transfer row in the source team, got ${JSON.stringify(sourceLog)}`,
  );
  const destLog = await db
    .select({ message: activitiesTable.message, appId: activitiesTable.appId })
    .from(activitiesTable)
    .where(eq(activitiesTable.teamId, TEAM_B));
  assert.equal(destLog.length, 1);
  assert.match(destLog[0].message, /^Received .* from alpha$/);
  assert.equal(destLog[0].appId, APP);
});

test("transfer refuses a team the caller can't deploy in, and its own team", async () => {
  await assert.rejects(
    asOwner(() => transferAppToTeam(APP, TEAM_C)),
    /only transfer an app to a team you belong to/,
  );
  await assert.rejects(
    asOwner(() => transferAppToTeam(APP, TEAM_A)),
    /already in this team/,
  );
  await assert.rejects(
    asOwner(() => transferAppToTeam(APP, "team_nope")),
    /only transfer an app to a team you belong to/,
  );
  assert.equal((await appRow()).teamId, TEAM_A);
});

test("transfer needs manage_env in the source team (the app carries its secrets)", async () => {
  await pg.query(
    `delete from membership_capabilities where membership_id = 'mem_${USER_1}' and capability = 'manage_env';`,
  );
  await assert.rejects(
    asOwner(() => transferAppToTeam(APP, TEAM_B)),
    /permission/i,
  );
  assert.equal((await appRow()).teamId, TEAM_A);
});

test("an app from another team is not found", async () => {
  await seedApp(db, { id: "prj_foreign", teamId: TEAM_B, slug: "foreign" });
  await assert.rejects(
    asOwner(() => transferAppToTeam("prj_foreign", TEAM_B)),
    /App not found/,
  );
});

test("transfer is refused when the destination team can't target the server", async () => {
  // Restrict the server to the source team only.
  await db
    .update(serversTable)
    .set({ allTeams: false })
    .where(eq(serversTable.id, SERVER_1));
  await db
    .insert(serverTeamsTable)
    .values({ serverId: SERVER_1, teamId: TEAM_A });

  const info = await asOwner(() => appTransferInfo(APP));
  assert.deepEqual(
    info.targets.map((t) => [t.name, t.serverAvailable]),
    [["beta", false]],
  );
  await assert.rejects(
    asOwner(() => transferAppToTeam(APP, TEAM_B)),
    /isn't available to this team/,
  );
  assert.equal((await appRow()).teamId, TEAM_A);
});

test("the GitHub connection is cut unless the destination owns one for the account", async () => {
  const sourceInstall = await seedGithub(TEAM_A, "o", 1);
  await db
    .update(appsTable)
    .set({ repoInstallationId: sourceInstall, autoDeploy: true })
    .where(eq(appsTable.id, APP));

  const info = await asOwner(() => appTransferInfo(APP));
  assert.equal(info.githubConnected, true);
  assert.equal(info.targets[0].githubFollows, false);

  await asOwner(() => transferAppToTeam(APP, TEAM_B));
  const app = await appRow();
  assert.equal(app.teamId, TEAM_B);
  // The old team's App credentials must not travel with it.
  assert.equal(app.repoInstallationId, null);
  // Auto-deploy cannot fire without it.
  assert.equal(app.autoDeploy, false);
});

test("the GitHub connection follows when the destination has its own installation", async () => {
  const sourceInstall = await seedGithub(TEAM_A, "o", 1);
  const destInstall = await seedGithub(TEAM_B, "O", 2); // same account, other case
  await db
    .update(appsTable)
    .set({ repoInstallationId: sourceInstall, autoDeploy: true })
    .where(eq(appsTable.id, APP));

  const info = await asOwner(() => appTransferInfo(APP));
  assert.equal(info.targets[0].githubFollows, true);

  await asOwner(() => transferAppToTeam(APP, TEAM_B));
  const app = await appRow();
  assert.equal(app.repoInstallationId, destInstall);
  assert.equal(app.autoDeploy, true);
});

test("appTransferInfo lists only the viewer's other deploy-capable teams, and what the move costs", async () => {
  await db.insert(sharedEnvVarsTable).values({
    id: "sev_1",
    teamId: TEAM_A,
    key: "SHARED",
    valueEnc: encryptSecret("v"),
    type: "plain",
    teamWide: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(sharedEnvVarAppsTable).values({ varId: "sev_1", appId: APP });
  await seedS3(db, { id: "s3_1", teamId: TEAM_A });
  await seedBackup(db, {
    id: "bkp_1",
    teamId: TEAM_A,
    destinationId: "s3_1",
    targetKind: "app",
    appId: APP,
  });

  const info = await asOwner(() => appTransferInfo(APP));
  // gamma (view only) and alpha (the active team) are not offered.
  assert.deepEqual(
    info.targets.map((t) => t.name),
    ["beta"],
  );
  assert.equal(info.targets[0].serverAvailable, true);
  assert.equal(info.targets[0].githubFollows, true); // nothing to lose
  assert.equal(info.sharedVarCount, 1);
  assert.equal(info.backupCount, 1);
  assert.equal(info.githubConnected, false);
  assert.equal(info.homeLabel, null);
  assert.equal(info.serverName, SERVER_1);
});

test("appTransferInfo names the folder the app would leave", async () => {
  await pg.query(
    `insert into folders (id, team_id, name, created_at, updated_at)
     values ('fld_1', '${TEAM_A}', 'Marketing', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`,
  );
  await db
    .update(appsTable)
    .set({ folderId: "fld_1" })
    .where(eq(appsTable.id, APP));
  const info = await asOwner(() => appTransferInfo(APP));
  assert.equal(info.homeLabel, "folder Marketing");

  await asOwner(() => transferAppToTeam(APP, TEAM_B));
  assert.equal((await appRow()).folderId, null);
  // The folder itself stays with the team that owns it.
  const folders = await db
    .select()
    .from(appsTable)
    .where(and(eq(appsTable.id, APP), eq(appsTable.teamId, TEAM_B)));
  assert.equal(folders.length, 1);
});
