import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { encryptSecret } from "../../crypto";
import { TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { seedApp, seedServer, SERVER_1 } from "../app-graph-test-helpers";
import { seedBackup, seedDatabase, seedS3 } from "../backup-test-helpers";
import { seedBase, USER_MEMBER } from "./databases-test-helpers";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../../db/schema/control-plane/access-control";
import { activities as activitiesTable } from "../../db/schema/control-plane/activity";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { cronJobs as cronJobsTable } from "../../db/schema/control-plane/crons";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { teamDatabaseOrder } from "../../db/schema/control-plane/display-order";
import {
  envVars as envVarsTable,
  sharedEnvVarApps as sharedEnvVarAppsTable,
  sharedEnvVars as sharedEnvVarsTable,
} from "../../db/schema/control-plane/env-vars";
import {
  servers as serversTable,
  serverTeams as serverTeamsTable,
} from "../../db/schema/control-plane/servers";
import { environments as environmentsTable } from "../../db/schema/control-plane/projects";
import { seedProject } from "../tokens/tokens-test-helpers";
import { mentionsHost } from "../database-usage";
import { databaseTransferInfo, transferDatabaseToTeam } from "./team-transfer";
import type { Capability } from "../../types/identity";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const DB = "db_shop";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

async function joinTeam(
  userId: string,
  teamId: string,
  capabilities: Capability[],
): Promise<void> {
  const id = `mem_${userId}_${teamId}`;
  await db
    .insert(membershipsTable)
    .values({ id, userId, teamId, role: "member", createdAt: T0 });
  await db
    .insert(membershipCapabilitiesTable)
    .values(
      capabilities.map((capability) => ({ membershipId: id, capability })),
    );
}

const dbRow = async (id = DB) =>
  (
    await db
      .select()
      .from(databasesTable)
      .where(eq(databasesTable.id, id))
      .limit(1)
  )[0];

async function setEnv(appId: string, key: string, value: string) {
  await db.insert(envVarsTable).values({
    id: `env_${appId}_${key}`,
    appId,
    key,
    valueEnc: encryptSecret(value),
    type: "secret",
    createdAt: T0,
    updatedAt: T0,
  });
}

beforeEach(async () => {
  await pg.exec(
    "truncate table activities, cron_jobs, env_vars, shared_env_vars, apps restart identity cascade;",
  );
  await seedBase(db, pg);
  await seedDatabase(db, { id: DB, name: "shop" });
});

test("a host is matched as a whole token only", () => {
  assert.ok(mentionsHost("postgres://u:p@db-shop:5432/x", "db-shop"));
  assert.ok(mentionsHost("REDIS_HOST=db-shop", "db-shop"));
  assert.ok(mentionsHost("host: DB-SHOP\n", "db-shop"));
  assert.ok(!mentionsHost("postgres://u:p@db-shop-2:5432/x", "db-shop"));
  assert.ok(!mentionsHost("x.db-shop.internal", "db-shop"));
  assert.ok(!mentionsHost("mydb-shop", "db-shop"));
});

test("transfers the database and severs every tie to the team it came from", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_databases"]);
  const dest = await seedS3(db, { id: "s3_1", teamId: TEAM_A });
  await seedBackup(db, {
    id: "bkp_1",
    teamId: TEAM_A,
    databaseId: DB,
    destinationId: dest,
  });
  await db.insert(backupRunsTable).values({
    id: "run_1",
    teamId: TEAM_A,
    backupId: "bkp_1",
    targetKind: "database",
    databaseId: DB,
    destinationId: dest,
    targetId: DB,
    objectKey: "k",
    sizeBytes: 1,
    status: "success",
    startedAt: T0,
  });
  await db.insert(cronJobsTable).values({
    id: "cron_1",
    teamId: TEAM_A,
    targetKind: "database",
    databaseId: DB,
    name: "vacuum",
    schedule: "0 3 * * *",
    command: "vacuumdb",
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .insert(teamDatabaseOrder)
    .values({ teamId: TEAM_A, databaseId: DB, position: 0 });
  await db.insert(activitiesTable).values({
    id: "act_1",
    teamId: TEAM_A,
    type: "database",
    message: "Created",
    actor: USER_1,
    databaseId: DB,
    createdAt: T0,
  });

  await as(USER_1, () => transferDatabaseToTeam(DB, TEAM_B));

  const row = await dbRow();
  assert.equal(row.teamId, TEAM_B);
  assert.equal(row.environmentId, null);
  assert.equal(row.host, "db-shop", "the host does not change");
  assert.equal(
    (await db.select().from(backupsTable)).length,
    0,
    "the schedule wrote to the old team's storage",
  );
  assert.equal((await db.select().from(cronJobsTable)).length, 0);
  assert.equal((await db.select().from(teamDatabaseOrder)).length, 0);
  const run = (await db.select().from(backupRunsTable))[0];
  assert.equal(run.teamId, TEAM_A, "backups already taken stay behind");
  assert.equal(run.databaseId, null);
  const acts = await db.select().from(activitiesTable);
  assert.equal(acts.find((a) => a.id === "act_1")?.databaseId, null);
  assert.ok(
    acts.some(
      (a) => a.teamId === TEAM_A && a.message.startsWith("Transferred"),
    ),
  );
  assert.ok(
    acts.some(
      (a) =>
        a.teamId === TEAM_B &&
        a.message.startsWith("Received") &&
        a.databaseId === DB,
    ),
  );
});

test("leaves its Environment and lands at the top level", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_databases"]);
  await seedProject(db, "prc_1", TEAM_A, "Shop");
  await db.insert(environmentsTable).values({
    id: "environ_1",
    projectId: "prc_1",
    name: "production",
    slug: "production",
    kind: "production",
    position: 0,
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .update(databasesTable)
    .set({ environmentId: "environ_1" })
    .where(eq(databasesTable.id, DB));

  const info = await as(USER_1, () => databaseTransferInfo(DB));
  assert.equal(info.environmentName, "production");
  await as(USER_1, () => transferDatabaseToTeam(DB, TEAM_B));
  assert.equal((await dbRow()).environmentId, null);
});

test("refuses when the destination already has a database with that name", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_databases"]);
  await seedServer(db, "srv_2");
  await seedDatabase(db, {
    id: "db_other",
    name: "shop",
    teamId: TEAM_B,
    serverId: "srv_2",
  });
  const info = await as(USER_1, () => databaseTransferInfo(DB));
  assert.equal(info.targets.find((t) => t.id === TEAM_B)?.nameTaken, true);
  await assert.rejects(
    as(USER_1, () => transferDatabaseToTeam(DB, TEAM_B)),
    /already has a database named "shop"/,
  );
  assert.equal((await dbRow()).teamId, TEAM_A);
});

test("needs move_databases in BOTH teams", async () => {
  await joinTeam(USER_MEMBER, TEAM_B, ["view", "move_databases"]);
  await assert.rejects(
    as(USER_MEMBER, () => transferDatabaseToTeam(DB, TEAM_B)),
    /move_databases|permission|Forbidden/i,
    "configure_databases here is not enough",
  );
  await assert.rejects(as(USER_MEMBER, () => databaseTransferInfo(DB)));

  await joinTeam(USER_1, TEAM_B, ["view", "create_databases"]);
  await assert.rejects(
    as(USER_1, () => transferDatabaseToTeam(DB, TEAM_B)),
    /don't have permission to manage databases in that team/,
  );
  const info = await as(USER_1, () => databaseTransferInfo(DB));
  assert.deepEqual(
    info.targets,
    [],
    "a team without the capability is not offered",
  );
  assert.equal((await dbRow()).teamId, TEAM_A);
});

test("refuses a team the user is not in, and its own team", async () => {
  await assert.rejects(
    as(USER_1, () => transferDatabaseToTeam(DB, TEAM_B)),
    /not a member of that team/,
  );
  await assert.rejects(
    as(USER_1, () => transferDatabaseToTeam(DB, TEAM_A)),
    /already in this team/,
  );
});

test("a database of another team is not found", async () => {
  await seedDatabase(db, { id: "db_b", name: "billing", teamId: TEAM_B });
  await joinTeam(USER_1, TEAM_B, ["view", "move_databases"]);
  await assert.rejects(
    as(USER_1, () => transferDatabaseToTeam("db_b", TEAM_B)),
    /Not found/,
  );
  assert.equal((await dbRow("db_b")).teamId, TEAM_B);
});

test("refuses when the server is not shared with the destination", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_databases"]);
  await db
    .update(serversTable)
    .set({ allTeams: false })
    .where(eq(serversTable.id, SERVER_1));
  await db
    .insert(serverTeamsTable)
    .values({ serverId: SERVER_1, teamId: TEAM_A });
  const info = await as(USER_1, () => databaseTransferInfo(DB));
  assert.equal(info.targets[0]?.serverAvailable, false);
  await assert.rejects(
    as(USER_1, () => transferDatabaseToTeam(DB, TEAM_B)),
    /can't use the server this database runs on/,
  );
  assert.equal((await dbRow()).teamId, TEAM_A);
});

test("refuses a database that is still being created", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_databases"]);
  await db
    .update(databasesTable)
    .set({ status: "provisioning" })
    .where(eq(databasesTable.id, DB));
  await assert.rejects(
    as(USER_1, () => transferDatabaseToTeam(DB, TEAM_B)),
    /still being created/,
  );
});

test("names the apps of this team that reach it by host", async () => {
  await joinTeam(USER_1, TEAM_B, ["view", "move_databases"]);
  await seedDatabase(db, { id: "db_shop2", name: "shop-2" });
  await seedApp(db, { id: "web", slug: "web" });
  await seedApp(db, { id: "worker", slug: "worker" });
  await seedApp(db, { id: "stack", slug: "stack" });
  await seedApp(db, { id: "other", slug: "other" });
  await seedApp(db, { id: "linked", slug: "linked" });
  await seedApp(db, { id: "far", slug: "far", teamId: TEAM_B });
  await setEnv("web", "DATABASE_URL", "postgres://app:pw@db-shop:5432/shop");
  await setEnv("worker", "PGHOST", "db-shop");
  await setEnv("other", "DATABASE_URL", "postgres://app:pw@db-shop-2:5432/x");
  await setEnv("far", "DATABASE_URL", "postgres://app:pw@db-shop:5432/shop");
  await db
    .update((await import("../../db/schema/control-plane/apps")).apps)
    .set({
      compose: "services:\n  api:\n    environment:\n      DB: db-shop\n",
    })
    .where(
      eq((await import("../../db/schema/control-plane/apps")).apps.id, "stack"),
    );
  await db.insert(sharedEnvVarsTable).values({
    id: "svar_1",
    teamId: TEAM_A,
    key: "SHOP_URL",
    valueEnc: encryptSecret("redis://db-shop:6379"),
    type: "secret",
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .insert(sharedEnvVarAppsTable)
    .values({ varId: "svar_1", appId: "linked" });

  const info = await as(USER_1, () => databaseTransferInfo(DB));
  assert.deepEqual(info.usedBy, ["linked", "stack", "web", "worker"]);
  assert.equal(info.running, true);
});
