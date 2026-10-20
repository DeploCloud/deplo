import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "../app-graph-test-helpers";
import { ipToHex } from "../../deploy/domains";
import {
  __resetAgentAddressesForTest,
  __setAgentAddressesForTest,
} from "./addresses";
import { setServerAddressFamily } from "./address-family";
import { getServerById } from "./roster";

const MEMBER = "usr_member";
const V4 = "198.51.100.1";
const V6 = "2001:db8::5";
const AUTO_V4 = `web-calm-fox-${ipToHex(V4)}.deplo.site`;
const AUTO_V6 = "web-calm-fox-v6-2001-db8--5.deplo.site";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_SERVER_IP = "203.0.113.200";
});

after(async () => {
  __resetTestDb();
  __resetAgentAddressesForTest();
  delete process.env.DEPLO_SERVER_IP;
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table activities, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await seedServer(db, SERVER_1, { provisioned: true });
  await db
    .update(serversTable)
    .set({ ip: V4, host: V4 })
    .where(eq(serversTable.id, SERVER_1));
  __setAgentAddressesForTest(async () => [V4, V6]);
  await seedApp(db, { id: "app_web", slug: "web" });
  const base = {
    appId: "app_web",
    status: "valid",
    ssl: false,
    port: 3000,
    certProvider: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await db.insert(domainsTable).values([
    { ...base, id: "dom_auto", name: AUTO_V4, isPrimary: true, source: "auto" },
    {
      ...base,
      id: "dom_own",
      name: "web.example.com",
      isPrimary: false,
      source: "custom",
    },
  ]);
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

async function names(): Promise<string[]> {
  const rows = await db
    .select({ name: domainsTable.name })
    .from(domainsTable)
    .orderBy(domainsTable.id);
  return rows.map((r) => r.name);
}

test("switching to IPv6 renames every generated name on the server, and nothing else", async () => {
  await asOwner(async () => {
    const { server, appsMoved } = await setServerAddressFamily(
      SERVER_1,
      "ipv6",
    );
    assert.equal(server.generatedAddressFamily, "ipv6");
    assert.equal(appsMoved, 1);
  });
  assert.deepEqual(await names(), [AUTO_V6, "web.example.com"]);
  const [app] = await db
    .select({ url: appsTable.productionUrl })
    .from(appsTable)
    .where(eq(appsTable.id, "app_web"));
  assert.equal(app.url, `http://${AUTO_V6}`);
});

test("automatic goes back to the IPv4 name", async () => {
  await asOwner(async () => {
    await setServerAddressFamily(SERVER_1, "ipv6");
    const { server, appsMoved } = await setServerAddressFamily(SERVER_1, null);
    assert.equal(server.generatedAddressFamily, null);
    assert.equal(appsMoved, 1);
  });
  assert.deepEqual(await names(), [AUTO_V4, "web.example.com"]);
});

test("a server with no IPv6 refuses the switch and keeps its names", async () => {
  __setAgentAddressesForTest(async () => [V4]);
  await asOwner(async () => {
    await assert.rejects(
      () => setServerAddressFamily(SERVER_1, "ipv6"),
      /no IPv6 address/,
    );
    assert.equal((await getServerById(SERVER_1))!.generatedAddressFamily, null);
  });
  assert.deepEqual(await names(), [AUTO_V4, "web.example.com"]);
});

test("an unknown kind is refused, not read as automatic", async () => {
  await asOwner(async () => {
    await assert.rejects(
      () => setServerAddressFamily(SERVER_1, "ipv5" as never),
      /Unknown address kind/,
    );
  });
});

test("only an instance admin may switch it", async () => {
  await runWithIdentity({ userId: MEMBER, teamId: TEAM_A }, async () => {
    await assert.rejects(() => setServerAddressFamily(SERVER_1, "ipv6"));
  });
  assert.deepEqual(await names(), [AUTO_V4, "web.example.com"]);
});
