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
import {
  setServerAddressFamily,
  setServerPreferredAddress,
} from "./address-family";
import {
  serverAddresses as getServerAddresses,
  serverWildcardIp,
} from "./addresses";
import {
  followAddresses,
  isPrivateAddress,
  serverAddressViews,
} from "./address-checks";
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

test("automatic on the Deplo host falls back to a proven IPv6 when IPv4 does not answer", async () => {
  await db
    .update(serversTable)
    .set({ deploHost: true, ip: V4, host: V4 })
    .where(eq(serversTable.id, SERVER_1));
  await db.insert(serverAddresses).values([
    {
      serverId: SERVER_1,
      address: V4,
      origin: "machine",
      seenAt: "2026-11-22T13:00:00.000Z",
      checkedAt: "2026-11-22T13:00:00.000Z",
      provenAt: null,
      failingSince: "2026-11-22T12:00:00.000Z",
      problem: `${V4} does not reach main: nothing answers on port 443`,
    },
    proven(V6),
  ]);
  const s = (await getServerById(SERVER_1))!;
  assert.equal(await serverWildcardIp(s), V6);
});

test("selecting a specific IPv6 overrides alphabetical order and respects moveExisting", async () => {
  const V6_A = "2a02:908:d16:a3e0::5249";
  const V6_B = "2a02:908:d16:a3e0:db52:2afc:bd15:e6ae";
  await db.insert(serverAddresses).values([proven(V6_A), proven(V6_B)]);

  // Automatic picks V6_A (alphabetically first among proven IPv6).
  assert.equal(await serverWildcardIp((await getServerById(SERVER_1))!), V6_A);

  // Pick V6_B without moving existing domains.
  await asOwner(async () => {
    const { server, appsMoved } = await setServerPreferredAddress(
      SERVER_1,
      V6_B,
      { moveExisting: false },
    );
    assert.equal(server.preferredAddress, V6_B);
    assert.equal(server.generatedAddressFamily, null);
    assert.equal(appsMoved, 0);
  });
  assert.deepEqual(await names(), [AUTO_V4, "web.example.com"]);
  const afterPick = (await getServerById(SERVER_1))!;
  assert.equal(await serverWildcardIp(afterPick), V6_B);
  assert.equal((await getServerAddresses(afterPick)).v6[0], V6_B);

  // Switch to V6_A with moveExisting: true (after seeding an auto domain on V6_B).
  const autoB =
    "web-calm-fox-v6-2a02-908-d16-a3e0-db52-2afc-bd15-e6ae.deplo.site";
  const autoA = "web-calm-fox-v6-2a02-908-d16-a3e0--5249.deplo.site";
  await db
    .update(domainsTable)
    .set({ name: autoB })
    .where(eq(domainsTable.id, "dom_auto"));
  await asOwner(async () => {
    const { server, appsMoved } = await setServerPreferredAddress(
      SERVER_1,
      V6_A,
      { moveExisting: true },
    );
    assert.equal(server.preferredAddress, V6_A);
    assert.equal(appsMoved, 1);
  });
  assert.deepEqual(await names(), [autoA, "web.example.com"]);
});

test("setServerPreferredAddress refuses an unreachable or unknown IP and non-admins", async () => {
  await db.insert(serverAddresses).values([
    {
      serverId: SERVER_1,
      address: V4,
      origin: "machine",
      seenAt: "2026-11-22T13:00:00.000Z",
      checkedAt: "2026-11-22T13:00:00.000Z",
      provenAt: null,
      failingSince: "2026-11-22T12:00:00.000Z",
      problem: "nothing answers on port 443",
    },
    proven(V6),
  ]);
  await asOwner(async () => {
    await assert.rejects(
      () => setServerPreferredAddress(SERVER_1, V4),
      /not an active address/,
    );
    await assert.rejects(
      () => setServerPreferredAddress(SERVER_1, "not-an-ip"),
      /not an IPv4 or IPv6 address/,
    );
  });
  await runWithIdentity({ userId: MEMBER, teamId: TEAM_A }, async () => {
    await assert.rejects(() => setServerPreferredAddress(SERVER_1, V6));
  });
});

test("preferredAddress falls back to automatic if it stops being published", async () => {
  const V6_A = "2a02:908:d16:a3e0::5249";
  const V6_B = "2a02:908:d16:a3e0:db52:2afc:bd15:e6ae";
  await db.insert(serverAddresses).values([proven(V6_A), proven(V6_B)]);
  await asOwner(() =>
    setServerPreferredAddress(SERVER_1, V6_B, { moveExisting: false }),
  );
  assert.equal(await serverWildcardIp((await getServerById(SERVER_1))!), V6_B);

  // V6_B leaves; Automatic falls back to V6_A.
  await db.delete(serverAddresses).where(eq(serverAddresses.address, V6_B));
  assert.equal(await serverWildcardIp((await getServerById(SERVER_1))!), V6_A);
});

test("private/VPN addresses stay visible and flagged isPrivate, never chosen automatically, but selectable manually", async () => {
  const VPN_V4 = "100.102.110.62";
  const VPN_V6 = "fd0a:79bd:c887:ba3f::1";
  assert.equal(isPrivateAddress(VPN_V4), true);
  assert.equal(isPrivateAddress(VPN_V6), true);
  assert.equal(isPrivateAddress(V6), false);

  await db
    .insert(serverAddresses)
    .values([proven(VPN_V4), proven(VPN_V6), proven(V6)]);

  const views = await serverAddressViews(SERVER_1);
  assert.equal(views.find((v) => v.address === VPN_V4)!.isPrivate, true);
  assert.equal(views.find((v) => v.address === VPN_V6)!.isPrivate, true);
  assert.equal(views.find((v) => v.address === V6)!.isPrivate, false);

  // Automatic NEVER picks private/VPN IPv4 even though IPv4 beats IPv6 for public addresses.
  assert.equal(await serverWildcardIp((await getServerById(SERVER_1))!), V6);

  // Admin can explicitly select the VPN IPv4 as primary.
  await asOwner(async () => {
    const { server } = await setServerPreferredAddress(SERVER_1, VPN_V4, {
      moveExisting: false,
    });
    assert.equal(server.preferredAddress, VPN_V4);
  });
  const after = (await getServerById(SERVER_1))!;
  assert.equal(await serverWildcardIp(after), VPN_V4);
  assert.equal((await getServerAddresses(after)).v4[0], VPN_V4);
});
