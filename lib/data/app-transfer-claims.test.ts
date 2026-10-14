import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../db/schema/control-plane/access-control";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import {
  servers as serversTable,
  serverTeams as serverTeamsTable,
} from "../db/schema/control-plane/servers";
import { transferAppToTeam } from "./app-transfer";
import type { Capability } from "../types/identity";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const APP = "prj_app";
const SIBLING = "prj_api";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

const transfer = () =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    transferAppToTeam(APP, TEAM_B),
  );

const teamOf = async (appId: string) =>
  (
    await db
      .select({ teamId: appsTable.teamId })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
  )[0]?.teamId;

async function seedDomain(
  id: string,
  appId: string,
  name: string,
  pathPrefix: string | null = null,
): Promise<void> {
  await db.insert(domainsTable).values({
    id,
    appId,
    name,
    status: "valid",
    isPrimary: false,
    ssl: true,
    pathPrefix,
    createdAt: T0,
  });
}

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  const membershipId = `mem_${USER_1}_${TEAM_B}`;
  await db.insert(membershipsTable).values({
    id: membershipId,
    userId: USER_1,
    teamId: TEAM_B,
    role: "member",
    createdAt: T0,
  });
  await db
    .insert(membershipCapabilitiesTable)
    .values(
      (["view", "move_apps", "create_apps", "manage_env"] as Capability[]).map(
        (capability) => ({ membershipId, capability }),
      ),
    );
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A });
  await seedApp(db, { id: SIBLING, teamId: TEAM_A, slug: "api" });
});

test("a preview server the destination can't use refuses the transfer", async () => {
  await seedServer(db, "srv_2");
  await db
    .update(serversTable)
    .set({ allTeams: false })
    .where(eq(serversTable.id, "srv_2"));
  await db
    .insert(serverTeamsTable)
    .values({ serverId: "srv_2", teamId: TEAM_A });
  await db
    .update(appsTable)
    .set({ previewServerId: "srv_2" })
    .where(eq(appsTable.id, APP));

  await assert.rejects(transfer, /previews run on \(srv_2\)/);
  assert.equal(await teamOf(APP), TEAM_A);

  await db
    .insert(serverTeamsTable)
    .values({ serverId: "srv_2", teamId: TEAM_B });
  await transfer();
  assert.equal(await teamOf(APP), TEAM_B);
});

test("a hostname another app here keeps never splits across two teams", async () => {
  await seedDomain("dom_root", APP, "shop.acme.com");
  await seedDomain("dom_api", SIBLING, "shop.acme.com", "/api");

  await assert.rejects(transfer, /A hostname belongs to one team/);
  assert.equal(await teamOf(APP), TEAM_A);

  await db.delete(domainsTable).where(eq(domainsTable.id, "dom_api"));
  await transfer();
  assert.equal(await teamOf(APP), TEAM_B);
});

test("a preview zone overlapping another app's domain here refuses the transfer", async () => {
  await db
    .update(appsTable)
    .set({ previewBaseDomain: "preview.acme.com" })
    .where(eq(appsTable.id, APP));
  await seedDomain("dom_api", SIBLING, "acme.com");

  await assert.rejects(transfer, /A preview domain belongs to one team/);
  assert.equal(await teamOf(APP), TEAM_A);
});

test("the app's own hostnames and preview zone travel with it", async () => {
  await db
    .update(appsTable)
    .set({ previewBaseDomain: "preview.acme.com" })
    .where(eq(appsTable.id, APP));
  await seedDomain("dom_root", APP, "acme.com");
  await seedDomain("dom_api", APP, "acme.com", "/api");

  await transfer();
  assert.equal(await teamOf(APP), TEAM_B);
});
