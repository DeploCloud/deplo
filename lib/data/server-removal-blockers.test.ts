import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { backupDestination } from "../db/schema/control-plane/backups";
import { activities } from "../db/schema/control-plane/activity";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_PROJECT_GRAPH, seedApp } from "./app-graph-test-helpers";
import { seedDatabase, seedDestination } from "./backup-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { removeServer } from "./servers/removal";
import {
  moveOffServer,
  removeDestinationOffServer,
  serverRemovalBlockers,
} from "./servers/removal-blockers";
import { getServerById } from "./servers/roster";

let db: TestDb;
let pg: PGlite;

const SERVER = "srv_target";
const READY = "srv_ready";
const PRIVATE = "srv_private";
// One fingerprint per server: they are unique, and a clash would drop the row silently.
const agent = (n: number) => ({
  certFingerprint: `sha256:pinned-${n}`,
  certPem: "-----BEGIN CERTIFICATE-----",
  version: "1.0.0",
});

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_PUBLIC_URL = "https://deplo.test";
  process.env.DEPLO_SERVER_IP = "192.0.2.200";
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table backup_destination, databases, activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_b", teamId: TEAM_B, role: "member", isInstanceAdmin: false },
    ],
  });
  const ip = (n: number) => ({ ip: `192.0.2.${n}`, host: `192.0.2.${n}` });
  await seedServerRow(db, {
    id: SERVER,
    name: "target",
    ...ip(10),
    agent: agent(10),
  });
  await seedServerRow(db, {
    id: READY,
    name: "ready",
    ...ip(11),
    agent: agent(11),
  });
  await seedServerRow(db, {
    id: PRIVATE,
    name: "private",
    ...ip(12),
    agent: agent(12),
    allTeams: false,
  });
  await seedServerRow(db, {
    id: "srv_down",
    name: "down",
    ...ip(14),
    agent: agent(14),
    status: "offline",
  });
  // Registered but never installed: nothing can move there.
  await seedServerRow(db, { id: "srv_bare", name: "bare", ...ip(13) });
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("lists every team's workloads and destinations, with where each can go", async () => {
  await seedApp(db, {
    id: "prj_b",
    slug: "web",
    teamId: TEAM_B,
    serverId: SERVER,
  });
  await db
    .update(appsTable)
    .set({ logo: "/templates/umami.png", logoTone: "light" })
    .where(eq(appsTable.id, "prj_b"));
  await seedDatabase(db, { id: "db_1", name: "pg-main", serverId: SERVER });
  await seedDestination(db, {
    id: "dst_b",
    name: "Nightly",
    kind: "server",
    serverId: SERVER,
    teamId: TEAM_B,
  });

  const b = await asAdmin(() => serverRemovalBlockers(SERVER));

  assert.deepEqual(
    b.apps.map((a) => [a.id, a.teamName, a.moveTo.map((t) => t.id)]),
    [["prj_b", "beta", [READY]]],
  );
  assert.deepEqual(
    b.databases.map((d) => [d.name, d.moveTo.map((t) => t.id)]),
    [["pg-main", [READY]]],
  );
  assert.deepEqual(
    b.destinations.map((d) => [d.id, d.teamName]),
    [["dst_b", "beta"]],
  );
  assert.equal(b.online, true);
  // What the dialog draws each row's icon from.
  assert.deepEqual(
    [b.apps[0]!.logo, b.apps[0]!.logoTone, b.apps[0]!.engine],
    ["/templates/umami.png", "light", null],
  );
  assert.deepEqual(
    [b.databases[0]!.logo, b.databases[0]!.engine],
    [null, "postgres"],
  );
});

test("moves another team's app off the server, and that team's Activity says so", async () => {
  await seedApp(db, {
    id: "prj_b",
    slug: "web",
    teamId: TEAM_B,
    serverId: SERVER,
    source: "upload",
  });

  await asAdmin(() => moveOffServer(SERVER, "app", "prj_b", READY));

  const [row] = await db
    .select({ serverId: appsTable.serverId, teamId: appsTable.teamId })
    .from(appsTable)
    .where(eq(appsTable.id, "prj_b"));
  assert.deepEqual(row, { serverId: READY, teamId: TEAM_B });
  const trail = await db
    .select({ message: activities.message })
    .from(activities)
    .where(eq(activities.teamId, TEAM_B));
  assert.ok(
    trail.some((a) =>
      /Moved .* to ready: target is being removed/.test(a.message),
    ),
  );
  assert.deepEqual(
    (await asAdmin(() => serverRemovalBlockers(SERVER))).apps,
    [],
  );
});

test("refuses a server the app's team cannot use", async () => {
  await seedApp(db, {
    id: "prj_b",
    teamId: TEAM_B,
    serverId: SERVER,
    source: "upload",
  });
  await assert.rejects(
    () => asAdmin(() => moveOffServer(SERVER, "app", "prj_b", PRIVATE)),
    /Server not found/,
  );
});

test("moves nothing that is not on the server being removed", async () => {
  await seedApp(db, {
    id: "prj_elsewhere",
    teamId: TEAM_B,
    serverId: READY,
    source: "upload",
  });
  await assert.rejects(
    () => asAdmin(() => moveOffServer(SERVER, "app", "prj_elsewhere", READY)),
    /not on this server/,
  );
});

test("removing another team's destination from here lets the server go", async () => {
  await seedDestination(db, {
    id: "dst_b",
    name: "Nightly",
    kind: "server",
    serverId: SERVER,
    teamId: TEAM_B,
  });

  await asAdmin(() => removeDestinationOffServer(SERVER, "dst_b", false));

  assert.equal(
    (
      await db
        .select()
        .from(backupDestination)
        .where(eq(backupDestination.id, "dst_b"))
    ).length,
    0,
  );
  await asAdmin(() => removeServer(SERVER));
  assert.equal(await getServerById(SERVER), null);
});

test("only an instance admin reads or acts on them", async () => {
  await seedDestination(db, {
    id: "dst_b",
    kind: "server",
    serverId: SERVER,
    teamId: TEAM_B,
  });
  const asMember = <T>(fn: () => Promise<T>) =>
    runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);
  await assert.rejects(() => asMember(() => serverRemovalBlockers(SERVER)));
  await assert.rejects(() =>
    asMember(() => removeDestinationOffServer(SERVER, "dst_b", false)),
  );
});
