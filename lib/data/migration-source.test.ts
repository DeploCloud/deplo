import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

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
import {
  addServer,
  listServersForTeam,
  getPrimaryServer,
  updateServerAgent,
} from "./servers";
import { updateAppSource } from "./apps";
import { setAppPreviewSettings } from "./previews";
import { createDestination } from "./destinations";
import { runCleanupNow } from "./docker-cleanup";
import { checkServerReadiness } from "./server-readiness";
import { servers as serversTable } from "../db/schema/control-plane";
import { eq } from "drizzle-orm";

/**
 * A MIGRATION SOURCE is not a server you have - it is a server you are LEAVING.
 *
 * Deplo installs an agent on the other platform's host because a volume can only
 * be read by the agent standing on the disk that holds it. Everything here pins
 * the consequence: that machine is not ours, so nothing may aim work at it, and
 * nobody else's team may even see it.
 *
 * The gaps these close were real. `canHostWorkloads` guards creation, but the app
 * MOVE and the preview server only ever checked team access - so an id sent
 * through the API landed work on a host that runs nothing. And every build-side
 * check read `storageOnly` alone, which a migration source passes: it has Docker,
 * it is just not ours.
 */

let db: TestDb;
let pg: PGlite;

const HOST = "192.0.2.77";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_PUBLIC_URL = "https://deplo.test";
  // Pin what this instance believes its own address is: addServer refuses a
  // migration source registered on the Deplo host, and without this the guard
  // would compare against whatever NICs the runner happens to have.
  process.env.DEPLO_SERVER_IP = "192.0.2.200";
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table backup_destination, activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db); // SERVER_1: an ordinary host, all teams
});

/** The other team's owner, to prove a migration source is invisible outside the
 *  one team that is migrating. */
const USER_2 = "user_2";

const asTeamA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** Register one the way the import wizard does, and give it a live agent. */
async function migrationSource(host = HOST): Promise<string> {
  const { server } = await asTeamA(() =>
    addServer({ name: "dokploy-host", host, importOnly: true }),
  );
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: `sha256:${server.id}`, agentPort: 9443 })
    .where(eq(serversTable.id, server.id));
  return server.id;
}

test("a migration source belongs to the team that is migrating, and to no other", async () => {
  const id = await migrationSource();
  // Servers are the one cross-team resource and default to all_teams - which
  // would put the machine somebody is migrating from, by name and address, in
  // every other team's picker.
  const mine = await listServersForTeam(TEAM_A);
  assert.ok(mine.some((s) => s.id === id), "the importing team must see it");
  const theirs = await listServersForTeam(TEAM_B);
  assert.equal(
    theirs.some((s) => s.id === id),
    false,
    "another team could see a migration source",
  );
});

test("an app cannot be MOVED onto a migration source", async () => {
  const id = await migrationSource();
  await seedApp(db, { id: "prj_web", slug: "web", teamId: TEAM_A, serverId: SERVER_1 });
  await assert.rejects(
    () =>
      asTeamA(() =>
        updateAppSource("prj_web", {
          source: "docker-image",
          dockerImage: "nginx:alpine",
          repo: null,
          serverId: id,
        }),
      ),
    /migration source/i,
  );
});

test("previews cannot be pinned to a migration source", async () => {
  const id = await migrationSource();
  await seedApp(db, { id: "prj_web", slug: "web", teamId: TEAM_A, serverId: SERVER_1 });
  await assert.rejects(
    () => asTeamA(() => setAppPreviewSettings("prj_web", { serverId: id })),
    /Nothing is deployed on that server/i,
  );
});

test("a migration source is never the team's primary server", async () => {
  // "Primary" is the default place to put something, and a caller that takes it
  // would be aiming at a host that refuses everything.
  const id = await migrationSource();
  await db.delete(serversTable).where(eq(serversTable.id, SERVER_1));
  await asTeamA(async () => {
    const primary = await getPrimaryServer();
    assert.equal(primary, null, `getPrimaryServer returned the migration source ${id}`);
  });
});

test("backups are never stored on a migration source", async () => {
  const id = await migrationSource();
  await assert.rejects(
    () =>
      asTeamA(() =>
        createDestination({ name: "nightly", kind: "server", serverId: id }),
      ),
    /migration source/i,
  );
});

test("Deplo does not reclaim disk on a machine it is only importing from", async () => {
  // The manual sweep, which is reachable from the API and from MCP - the
  // scheduler's own filter does not cover it. A prune there would delete the
  // other platform's images while it is running on them.
  const id = await migrationSource();
  await assert.rejects(() => asTeamA(() => runCleanupNow(id)), /migration source/i);
});

test("readiness is not a question asked of a migration source", async () => {
  // It has no Traefik of ours and something else owns :80 - both true, both
  // normal, and reporting them as findings would describe a healthy machine as
  // broken.
  const id = await migrationSource();
  await assert.rejects(
    () => asTeamA(() => checkServerReadiness(id)),
    /migration source/i,
  );
});

test("the agent on a migration source is not upgraded, it is removed", async () => {
  // Upgrading an agent is maintenance of a host we run. This one we do not - and
  // the only thing that ever happens to its agent is that it goes away.
  const id = await migrationSource();
  await assert.rejects(
    () => asTeamA(() => updateServerAgent(id)),
    /migration source/i,
  );
});
