import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  serverAddresses,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
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
import { serverWildcardIp } from "./addresses";
import {
  setServerAddressFamily,
  setServerPreferredAddress,
} from "./address-family";
import { followAddresses, isPrivateAddress } from "./address-checks";
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
    truncate table server_addresses, activities, membership_capabilities, memberships, users, teams restart identity cascade;`);
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

const proven = (address: string) => ({
  serverId: SERVER_1,
  address,
  origin: "machine",
  seenAt: "2026-11-22T13:00:00.000Z",
  checkedAt: "2026-11-22T13:00:00.000Z",
  provenAt: "2026-11-22T13:00:00.000Z",
});

test("a new proven address moves every generated name on the server with it, and nothing else", async () => {
  const MOVED = "198.51.100.7";
  await db.insert(serverAddresses).values(proven(MOVED));
  await asOwner(() => followAddresses(SERVER_1, V4));
  const auto = `web-calm-fox-${ipToHex(MOVED)}.deplo.site`;
  assert.deepEqual(await names(), [auto, "web.example.com"]);
  const [app] = await db
    .select({ url: appsTable.productionUrl })
    .from(appsTable)
    .where(eq(appsTable.id, "app_web"));
  assert.equal(app.url, `http://${auto}`);
});

test("under Automatic a proven IPv4 carries the names; with none proven, the IPv6 does", async () => {
  await db.insert(serverAddresses).values([proven(V4), proven(V6)]);
  await asOwner(() => followAddresses(SERVER_1, V4));
  assert.deepEqual(await names(), [AUTO_V4, "web.example.com"]);
  await db.delete(serverAddresses).where(eq(serverAddresses.address, V4));
  await asOwner(() => followAddresses(SERVER_1, V4));
  assert.deepEqual(await names(), [AUTO_V6, "web.example.com"]);
});

const SECOND = "198.51.100.9";
const PRIVATE = "10.0.0.5";
const nameAt = (ip: string) => `web-calm-fox-${ipToHex(ip)}.deplo.site`;

test("choosing a proven address moves every generated name to it; Automatic brings them back", async () => {
  await db.insert(serverAddresses).values([proven(V4), proven(SECOND)]);
  await asOwner(async () => {
    const { server, appsMoved } = await setServerPreferredAddress(
      SERVER_1,
      SECOND,
    );
    assert.equal(server.preferredAddress, SECOND);
    assert.equal(appsMoved, 1);
  });
  assert.deepEqual(await names(), [nameAt(SECOND), "web.example.com"]);
  await asOwner(() => setServerPreferredAddress(SERVER_1, null));
  assert.deepEqual(await names(), [AUTO_V4, "web.example.com"]);
});

test("Automatic never names a private address; an admin may, and the row keeps the public one", async () => {
  await db.insert(serverAddresses).values([proven(V4), proven(PRIVATE)]);
  await asOwner(() => followAddresses(SERVER_1, V4));
  assert.deepEqual(await names(), [AUTO_V4, "web.example.com"]);
  await asOwner(() => setServerPreferredAddress(SERVER_1, PRIVATE));
  assert.deepEqual(await names(), [nameAt(PRIVATE), "web.example.com"]);
  assert.equal((await getServerById(SERVER_1))!.ip, V4);
});

test("a chosen address that stops reaching the server hands its names back to Automatic", async () => {
  await db.insert(serverAddresses).values([proven(V4), proven(SECOND)]);
  await asOwner(() => setServerPreferredAddress(SERVER_1, SECOND));
  await db.delete(serverAddresses).where(eq(serverAddresses.address, SECOND));
  await asOwner(() => followAddresses(SERVER_1, SECOND));
  assert.deepEqual(await names(), [AUTO_V4, "web.example.com"]);
});

test("an address that does not reach the server, or a private IPv6, is refused and moves nothing", async () => {
  await db.insert(serverAddresses).values([proven(V4), proven("fd00::5")]);
  await asOwner(async () => {
    await assert.rejects(
      () => setServerPreferredAddress(SERVER_1, SECOND),
      /does not reach/,
    );
    await assert.rejects(
      () => setServerPreferredAddress(SERVER_1, "fd00::5"),
      /cannot carry/,
    );
    assert.equal((await getServerById(SERVER_1))!.preferredAddress, null);
  });
  await runWithIdentity({ userId: MEMBER, teamId: TEAM_A }, async () => {
    await assert.rejects(() => setServerPreferredAddress(SERVER_1, V4));
  });
  assert.deepEqual(await names(), [AUTO_V4, "web.example.com"]);
});

test("IPv4 or IPv6 only clears a chosen address", async () => {
  await db
    .insert(serverAddresses)
    .values([proven(V4), proven(SECOND), proven(V6)]);
  await asOwner(() => setServerPreferredAddress(SERVER_1, SECOND));
  await asOwner(async () => {
    const { server } = await setServerAddressFamily(SERVER_1, "ipv6");
    assert.equal(server.preferredAddress, null);
  });
  assert.deepEqual(await names(), [AUTO_V6, "web.example.com"]);
});

test("a server reached only on a private network keeps its generated names under Automatic", async () => {
  await db
    .update(serversTable)
    .set({ ip: PRIVATE, host: PRIVATE })
    .where(eq(serversTable.id, SERVER_1));
  await db.insert(serverAddresses).values(proven(PRIVATE));
  assert.equal(
    await serverWildcardIp((await getServerById(SERVER_1))!),
    PRIVATE,
  );
});

test("on the Deplo host Automatic keeps the installer's address while proven, and takes the proven IPv6 once no IPv4 reaches it", async () => {
  const PANEL = "203.0.113.200";
  await db
    .update(serversTable)
    .set({ deploHost: true, ip: "127.0.0.1", host: "127.0.0.1" })
    .where(eq(serversTable.id, SERVER_1));
  const server = (await getServerById(SERVER_1))!;
  assert.equal(
    await serverWildcardIp(server),
    PANEL,
    "none proven: the installer's",
  );
  await db.insert(serverAddresses).values([proven(PANEL), proven(V6)]);
  assert.equal(await serverWildcardIp(server), PANEL);
  await db
    .update(serverAddresses)
    .set({ provenAt: null })
    .where(eq(serverAddresses.address, PANEL));
  assert.equal(await serverWildcardIp(server), V6);
});

test("private covers RFC 1918, the VPN range and IPv6 unique local, nothing public", () => {
  for (const a of [
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.1",
    "fd7a::1",
  ])
    assert.ok(isPrivateAddress(a), a);
  for (const a of ["172.32.0.1", "100.128.0.1", "198.51.100.1", "2001:db8::1"])
    assert.ok(!isPrivateAddress(a), a);
});
