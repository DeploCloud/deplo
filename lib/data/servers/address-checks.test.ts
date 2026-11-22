import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  serverAddresses as addressesTable,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { seedIdentity } from "../identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "../app-graph-test-helpers";
import {
  __setAddressProbesForTest,
  ADDRESS_LEAVES_AFTER_MS,
  addressPublished,
  checkServerAddresses,
  publishedServerAddresses,
  serverAddressViews,
  type AddressRow,
} from "./address-checks";
import { serverWildcardIp } from "./addresses";
import { getServerById } from "./roster";

// eu-1 on 22 Nov 2026: behind a router whose 443 goes to another machine, with an IPv6 of its own.
const ROUTER = "130.78.60.1";
const OLD_V6 = "2a07:7e87:546d:0:be24:11ff:fe40:3a0c";
const NEW_V6 = "2a07:7e87:9999:0:be24:11ff:fe40:3a0c";
const CERT = "a".repeat(64);

let db: TestDb;
let pg: PGlite;
// What the agent says, and what answers at each address on 443.
let machine: string[] = [];
let traffic: string[] = [];
let at443: Record<string, string | "closed" | "unreachable"> = {};

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setAgentConnectorForTest(async () => {
    const conn: Partial<AgentConnection> = {
      hello: async () =>
        ({
          capabilities: ["address.prove"],
          publicAddresses: machine,
        }) as Awaited<ReturnType<AgentConnection["hello"]>>,
      proveAddresses: async () => ({
        proxyCertificateSha256: CERT,
        trafficAddresses: traffic,
        dnsIdent: "",
      }),
      close: () => {},
    };
    return conn as AgentConnection;
  });
  __setAddressProbesForTest({
    tls: async (a) => {
      const v = at443[a] ?? "silent";
      if (v === "closed" || v === "unreachable") return { ok: false, why: v };
      if (v === "silent") return { ok: false, why: "silent" };
      return { ok: true, value: v };
    },
  });
});

after(async () => {
  __setAgentConnectorForTest();
  __setAddressProbesForTest(null);
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `${TRUNCATE_PROJECT_GRAPH} truncate table server_addresses, activities, users, teams restart identity cascade;`,
  );
  await seedIdentity(db);
  await seedServer(db, SERVER_1, { provisioned: true });
  await db
    .update(serversTable)
    .set({ ip: ROUTER, host: ROUTER, name: "eu-1" })
    .where(eq(serversTable.id, SERVER_1));
  machine = [OLD_V6];
  traffic = [ROUTER];
  at443 = { [ROUTER]: "b".repeat(64), [OLD_V6]: CERT };
});

test("a typed address stays in use until its first check", async () => {
  assert.equal(await publishedServerAddresses(SERVER_1), null);
  assert.equal(await serverWildcardIp(await getServerById(SERVER_1)), ROUTER);
});

test("an IPv4 whose 443 reaches another machine is never published, and the page says why", async () => {
  await checkServerAddresses();
  assert.deepEqual(await publishedServerAddresses(SERVER_1), {
    v4: [],
    v6: [OLD_V6],
  });
  const views = await serverAddressViews(SERVER_1);
  const router = views.find((v) => v.address === ROUTER)!;
  assert.equal(router.state, "notUsed");
  assert.equal(
    router.problem,
    `${ROUTER} does not reach eu-1: the router sends port 443 elsewhere`,
  );
  assert.equal(views.find((v) => v.address === OLD_V6)!.state, "inUse");
  // What Deplo names for it follows: its row, and the address its generated names carry.
  assert.equal((await getServerById(SERVER_1))!.ip, OLD_V6);
});

test("a new IPv6 prefix replaces the old address everywhere", async () => {
  await seedApp(db, { id: "app_web", slug: "web" });
  await db.insert(domainsTable).values({
    id: "dom_auto",
    appId: "app_web",
    name: `web-calm-fox-v6-${OLD_V6.replace(/:/g, "-")}.deplo.site`,
    status: "valid",
    ssl: false,
    port: 3000,
    certProvider: "none",
    isPrimary: true,
    source: "auto",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await checkServerAddresses();
  machine = [NEW_V6];
  at443 = { [ROUTER]: "b".repeat(64), [NEW_V6]: CERT };
  await checkServerAddresses();
  assert.deepEqual(await publishedServerAddresses(SERVER_1), {
    v4: [],
    v6: [NEW_V6],
  });
  assert.equal((await getServerById(SERVER_1))!.ip, NEW_V6);
  const [d] = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.id, "dom_auto"));
  assert.equal(
    d.name,
    `web-calm-fox-v6-${NEW_V6.replace(/:/g, "-")}.deplo.site`,
  );
});

test("a flapping check renames nothing: an address leaves only after failing for the whole window", async () => {
  await checkServerAddresses();
  at443[OLD_V6] = "closed";
  await checkServerAddresses();
  assert.deepEqual(await publishedServerAddresses(SERVER_1), {
    v4: [],
    v6: [OLD_V6],
  });
  const leaving = (await serverAddressViews(SERVER_1)).find(
    (v) => v.address === OLD_V6,
  )!;
  assert.equal(leaving.state, "leaving");
  assert.ok(leaving.leavesAt);
  at443[OLD_V6] = CERT;
  await checkServerAddresses();
  assert.equal(
    (await serverAddressViews(SERVER_1)).find((v) => v.address === OLD_V6)!
      .state,
    "inUse",
  );
  const row = (await db.select().from(addressesTable)).find(
    (r) => r.address === OLD_V6,
  )!;
  const t0 = Date.parse("2026-11-22T13:00:00Z");
  const failing: AddressRow = {
    ...row,
    failingSince: new Date(t0).toISOString(),
  };
  assert.equal(
    addressPublished(failing, t0 + ADDRESS_LEAVES_AFTER_MS - 1),
    true,
  );
  assert.equal(addressPublished(failing, t0 + ADDRESS_LEAVES_AFTER_MS), false);
});

test("an address Deplo cannot reach the family of is shown as not checked, never dropped", async () => {
  at443[OLD_V6] = "unreachable";
  await checkServerAddresses();
  const v6 = (await serverAddressViews(SERVER_1)).find(
    (v) => v.address === OLD_V6,
  )!;
  assert.equal(v6.state, "notChecked");
  assert.match(v6.problem, /^Not checked/);
  assert.deepEqual((await publishedServerAddresses(SERVER_1))?.v6, [OLD_V6]);
});
