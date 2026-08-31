import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { databases as databasesTable } from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { setAppPorts } from "./apps";
import { loadAppGraph } from "./app-graph-load";

/**
 * Host ports an app publishes - what deplo's proxy cannot route, and what used
 * to force anybody moving a game server or an SMTP relay to rewrite their app as
 * a compose stack by hand.
 */

let db: TestDb;
let pg: PGlite;

/** A Member who may configure apps and holds NEITHER orthogonal grant. */
const USER_3 = "user_3";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
      {
        id: USER_3,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "configure_apps"],
      },
    ],
  });
  await seedServer(db);
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_3, teamId: TEAM_A }, fn);

const port = (published: number, target: number, protocol = "tcp") => ({
  id: "",
  published,
  target,
  protocol: protocol as "tcp" | "udp",
});

test("a published port is saved, ordered, and read back", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asOwner(() =>
    setAppPorts("prj_1", [port(16379, 6379), port(25565, 25565, "udp")]),
  );

  const app = await loadAppGraph("prj_1");
  assert.deepEqual(
    app?.ports?.map((p) => `${p.published}:${p.target}/${p.protocol}`),
    ["16379:6379/tcp", "25565:25565/udp"],
  );
  // Every row gets an id of its own, so the editor can key them.
  assert.ok(app!.ports![0].id.startsWith("prt_"));
});

test("saving an empty set clears them", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asOwner(() => setAppPorts("prj_1", [port(16379, 6379)]));
  await asOwner(() => setAppPorts("prj_1", []));
  assert.equal((await loadAppGraph("prj_1"))?.ports, null);
});

// The container leaves the proxy behind and lands on the host's own network, so
// the same grant that gates a host mount gates this.
test("publishing a port needs the grant; clearing them does not", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await assert.rejects(
    () => asMember(() => setAppPorts("prj_1", [port(16379, 6379)])),
    /permission to publish ports/,
  );
  await asMember(() => setAppPorts("prj_1", []));
});

test("a privileged port and a duplicate are both refused", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await assert.rejects(
    () => asOwner(() => setAppPorts("prj_1", [port(80, 80)])),
    /between 1024 and 65535/,
  );
  await assert.rejects(
    () =>
      asOwner(() => setAppPorts("prj_1", [port(16379, 6379), port(16379, 1)])),
    /publishes 16379 twice/,
  );
});

// The rows are kept so a flip back to a single image recovers them, exactly as
// the compose file itself is kept - but a stack that publishes nothing must not
// hold a port away from everyone else.
test("a stack that became compose stops claiming its old ports", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await seedApp(db, { id: "prj_2", teamId: TEAM_B, slug: "two" });
  await asOwner(() => setAppPorts("prj_1", [port(16379, 6379)]));
  await db.execute("update apps set source = 'compose' where id = 'prj_1'");

  await runWithIdentity({ userId: "user_2", teamId: TEAM_B }, () =>
    setAppPorts("prj_2", [port(16379, 6379)]),
  );
});

test("a compose stack publishes its ports in its own file", async () => {
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    source: "compose",
    compose: "services:\n  web:\n    image: nginx\n",
  });
  await assert.rejects(
    () => asOwner(() => setAppPorts("prj_1", [port(16379, 6379)])),
    /own compose file/,
  );
});

// A host port is a singleton on the machine and the machine is shared, so the
// row that collides can belong to another team entirely.
test("a port another team's database already publishes is refused", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await db.insert(databasesTable).values({
    id: "db_other",
    teamId: TEAM_B,
    name: "theirs",
    type: "postgres",
    version: "16",
    host: "db-theirs",
    port: 5432,
    username: "app",
    dbName: "app",
    connectionStringEnc: "v1..x.y.z",
    status: "running",
    serverId: SERVER_1,
    exposedPublicly: true,
    exposedPort: 25432,
    cronEnabled: false,
    sizeMb: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await assert.rejects(
    () => asOwner(() => setAppPorts("prj_1", [port(25432, 5432)])),
    /already published on this server/,
  );
});

test("a port another APP publishes is refused, and its own is not", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await seedApp(db, { id: "prj_2", teamId: TEAM_B, slug: "two" });
  await asOwner(() => setAppPorts("prj_1", [port(16379, 6379)]));
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_2", teamId: TEAM_B }, () =>
        setAppPorts("prj_2", [port(16379, 6379)]),
      ),
    /already published on this server/,
  );
  // Re-saving its OWN port is not a collision with itself.
  await asOwner(() => setAppPorts("prj_1", [port(16379, 6380)]));
});
