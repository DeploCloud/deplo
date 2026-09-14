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
import { updateServerAgent } from "./servers/agent-maintenance";
import { addServer } from "./servers/enrollment";
import { listServersForTeam, getPrimaryServer } from "./servers/roster";
import { updateAppSource } from "./apps/source";
import { setAppPreviewSettings } from "./previews";
import { createDestination } from "./destinations/create";
import { runCleanupNow } from "./docker-cleanup/sweep";
import { checkServerReadiness } from "./server-readiness";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { eq } from "drizzle-orm";

let db: TestDb;
let pg: PGlite;

const HOST = "192.0.2.77";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_PUBLIC_URL = "https://deplo.test";
  // Pin the address this instance believes it has: otherwise the guard reads the runner's NICs.
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
  await seedServer(db);
});

const USER_2 = "user_2";

const asTeamA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

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
  // Servers default to all_teams, which would list the host being left in every team's picker.
  const mine = await listServersForTeam(TEAM_A);
  assert.ok(
    mine.some((s) => s.id === id),
    "the importing team must see it",
  );
  const theirs = await listServersForTeam(TEAM_B);
  assert.equal(
    theirs.some((s) => s.id === id),
    false,
    "another team could see a migration source",
  );
});

test("an app cannot be MOVED onto a migration source", async () => {
  const id = await migrationSource();
  await seedApp(db, {
    id: "prj_web",
    slug: "web",
    teamId: TEAM_A,
    serverId: SERVER_1,
  });
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
  await seedApp(db, {
    id: "prj_web",
    slug: "web",
    teamId: TEAM_A,
    serverId: SERVER_1,
  });
  await assert.rejects(
    () => asTeamA(() => setAppPreviewSettings("prj_web", { serverId: id })),
    /Nothing is deployed on that server/i,
  );
});

test("a migration source is never the team's primary server", async () => {
  const id = await migrationSource();
  await db.delete(serversTable).where(eq(serversTable.id, SERVER_1));
  await asTeamA(async () => {
    const primary = await getPrimaryServer();
    assert.equal(
      primary,
      null,
      `getPrimaryServer returned the migration source ${id}`,
    );
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
  const id = await migrationSource();
  await assert.rejects(
    () => asTeamA(() => runCleanupNow(id)),
    /migration source/i,
  );
});

test("readiness is not a question asked of a migration source", async () => {
  const id = await migrationSource();
  await assert.rejects(
    () => asTeamA(() => checkServerReadiness(id)),
    /migration source/i,
  );
});

test("the agent on a migration source is not upgraded, it is removed", async () => {
  const id = await migrationSource();
  await assert.rejects(
    () => asTeamA(() => updateServerAgent(id)),
    /migration source/i,
  );
});
