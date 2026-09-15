import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import { runWithIdentity } from "../../auth/request-context";
import { assertMigrationMachinesReady } from "../migration-data/source-cutover";
import { TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { SERVER_1 } from "../app-graph-test-helpers";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { scanMigrationSource } from "./scan";
import {
  migrationMachines,
  __setDnsLookupForTest,
  __resetDnsLookupForTest,
  setMigrationMachineAddress,
  rememberMigrationMachineAddress,
} from "./source-machines";
import { updateServerAddress } from "../servers/agent-maintenance";
import { addServer } from "../servers/enrollment";
import { removeServer } from "../servers/removal";
import { getServerById } from "../servers/roster";
import {
  URL_BASE,
  CONNECT,
  asOwner,
  seedSource,
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

test("a Dokploy machine Deplo already manages is recognised by its address", async () => {
  const { servers: serversTable } =
    await import("../../db/schema/control-plane/servers");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({ ip: "dokploy.acme.test", host: "dokploy.acme.test" })
    .where(eq(serversTable.id, SERVER_1));

  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const own = plan.servers.find((s) => s.sourceId === "")!;
  assert.equal(own.ipAddress, "dokploy.acme.test");
  assert.equal(own.deploServerId, SERVER_1);
  assert.equal(
    plan.servers.find((s) => s.sourceId === "dok-srv-1")!.deploServerId,
    null,
  );
});

test("a matched machine is dialed at scan, never assumed from its row", async () => {
  const { servers: serversTable } =
    await import("../../db/schema/control-plane/servers");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({
      ip: "dokploy.acme.test",
      host: "dokploy.acme.test",
      status: "online",
      statusCheckedAt: null,
    })
    .where(eq(serversTable.id, SERVER_1));

  const dialed: string[] = [];
  const answer = (ok: boolean) =>
    __setAgentConnectorForTest(async (id) => {
      dialed.push(id);
      if (!ok) throw new Error("14 UNAVAILABLE: No connection established");
      return {
        hello: async () => ({ contractVersion: 1, capabilities: [] }),
        close: () => {},
      } as unknown as Awaited<
        ReturnType<
          typeof import("../../infra/agent-client/connect").connectAgent
        >
      >;
    });

  answer(true);
  const up = await asOwner(() => scanMigrationSource(CONNECT));
  assert.equal(
    up.servers.find((s) => s.sourceId === "")!.deploServerOnline,
    true,
  );
  assert.deepEqual(dialed, [SERVER_1], "asked exactly once");

  await db
    .update(serversTable)
    .set({ statusCheckedAt: new Date().toISOString() })
    .where(eq(serversTable.id, SERVER_1));
  dialed.length = 0;
  answer(false);
  const down = await asOwner(() => scanMigrationSource(CONNECT));
  assert.equal(
    down.servers.find((s) => s.sourceId === "")!.deploServerOnline,
    false,
  );

  __setAgentConnectorForTest();
});

test("a machine already registered as a MIGRATION SOURCE is still recognised", async () => {
  const { servers: serversTable } =
    await import("../../db/schema/control-plane/servers");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({
      ip: "dokploy.acme.test",
      host: "dokploy.acme.test",
      importOnly: true,
    })
    .where(eq(serversTable.id, SERVER_1));

  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  assert.equal(
    plan.servers.find((s) => s.sourceId === "")!.deploServerId,
    SERVER_1,
  );
});

test("Dokploy on the machine Deplo runs on resolves to the agent already there", async () => {
  const { servers: serversTable } =
    await import("../../db/schema/control-plane/servers");
  const { eq } = await import("drizzle-orm");
  const beforeIp = process.env.DEPLO_SERVER_IP;
  const beforeUrl = process.env.DEPLO_PUBLIC_URL;
  await db
    .update(serversTable)
    .set({ ip: "10.9.9.9", host: "10.9.9.9" })
    .where(eq(serversTable.id, SERVER_1));
  process.env.DEPLO_SERVER_IP = "10.9.9.9";
  try {
    delete process.env.DEPLO_PUBLIC_URL;
    const plan = await asOwner(() => scanMigrationSource(CONNECT));
    assert.equal(
      plan.servers.find((s) => s.sourceId === "")!.deploServerId,
      null,
    );

    process.env.DEPLO_PUBLIC_URL = URL_BASE;
    const again = await asOwner(() => scanMigrationSource(CONNECT));
    assert.equal(
      again.servers.find((s) => s.sourceId === "")!.deploServerId,
      SERVER_1,
    );
  } finally {
    if (beforeIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = beforeIp;
    if (beforeUrl === undefined) delete process.env.DEPLO_PUBLIC_URL;
    else process.env.DEPLO_PUBLIC_URL = beforeUrl;
  }
});

test("a scan in another team adopts the source an earlier run registered there", async () => {
  const panelHost = new URL(URL_BASE).hostname;
  const credential = {
    kind: "dokploy" as const,
    baseUrl: URL_BASE,
    apiKey: CONNECT.apiKey,
  };
  const added = await asOwner(() =>
    addServer({ name: "dokploy-host", host: panelHost, importOnly: true }),
  );
  await db.execute(
    `insert into memberships (id, user_id, team_id, role, created_at) values ('mem_u1_b', '${USER_1}', '${TEAM_B}', 'owner', now())`,
  );
  await db.execute(
    `insert into membership_capabilities (membership_id, capability) select 'mem_u1_b', capability from membership_capabilities where membership_id = 'mem_${USER_1}'`,
  );
  const plan = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    scanMigrationSource(CONNECT),
  );
  assert.equal(plan.servers[0]?.deploServerId, added.server.id);
  const inB = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    migrationMachines(credential, TEAM_B),
  );
  assert.equal(inB[0]?.deploServerId, added.server.id, "granted to B now");
  const inA = await asOwner(() => migrationMachines(credential, TEAM_A));
  assert.equal(inA[0]?.deploServerId, null, "and no longer A's");
});

test("a panel behind Cloudflare is flagged instead of registered at the proxy", async () => {
  __setDnsLookupForTest(async () => [{ address: "104.16.0.1" }]);
  try {
    const rows = await asOwner(() =>
      migrationMachines(
        { kind: "dokploy" as const, baseUrl: URL_BASE, apiKey: CONNECT.apiKey },
        TEAM_A,
      ),
    );
    assert.equal(rows[0]?.sourceId, "", "the Dokploy host itself comes first");
    assert.equal(rows[0]?.cloudflare, true);
  } finally {
    __resetDnsLookupForTest();
  }
});

test("a corrected dial address keeps the machine recognisable by the one it came from", async () => {
  const panelHost = new URL(URL_BASE).hostname;
  const credential = {
    kind: "dokploy" as const,
    baseUrl: URL_BASE,
    apiKey: CONNECT.apiKey,
  };
  const added = await asOwner(() =>
    addServer({ name: "dokploy-host", host: panelHost, importOnly: true }),
  );

  const before = await asOwner(() => migrationMachines(credential, TEAM_A));
  assert.equal(before[0]?.sourceId, "", "the Dokploy host itself comes first");
  assert.equal(before[0]?.deploServerId, added.server.id);

  await asOwner(() =>
    updateServerAddress({
      id: added.server.id,
      address: "203.0.113.7",
      keepHost: true,
    }),
  );

  const server = await asOwner(() => getServerById(added.server.id));
  assert.equal(server?.ip, "203.0.113.7", "we dial the machine");
  assert.equal(server?.host, panelHost, "we remember where it came from");

  const after = await asOwner(() => migrationMachines(credential, TEAM_A));
  assert.equal(
    after[0]?.deploServerId,
    added.server.id,
    "still the same machine, not a second registration",
  );
});

test("a corrected address outlives the server row it was made on", async () => {
  const panelHost = new URL(URL_BASE).hostname;
  const credential = {
    kind: "dokploy" as const,
    baseUrl: URL_BASE,
    apiKey: CONNECT.apiKey,
  };
  const added = await asOwner(() =>
    addServer({ name: "dokploy-host", host: panelHost, importOnly: true }),
  );

  await asOwner(() =>
    setMigrationMachineAddress({
      sourceUrl: URL_BASE,
      sourceId: "",
      serverId: added.server.id,
      address: "203.0.113.7",
    }),
  );

  const during = await asOwner(() => migrationMachines(credential, TEAM_A));
  assert.equal(during[0]?.deploServerId, added.server.id);
  assert.equal(during[0]?.ipAddress, "203.0.113.7");

  await asOwner(() => removeServer(added.server.id));

  const after = await asOwner(() => migrationMachines(credential, TEAM_A));
  assert.equal(after[0]?.sourceId, "");
  assert.equal(
    after[0]?.ipAddress,
    "203.0.113.7",
    "the next attempt must register it where it actually is",
  );
  assert.equal(
    after[0]?.deploServerId,
    null,
    "and register it, since it is gone",
  );
});

test("a remembered address belongs to one team and one panel", async () => {
  const added = await asOwner(() =>
    addServer({
      name: "dokploy-host",
      host: new URL(URL_BASE).hostname,
      importOnly: true,
    }),
  );
  await asOwner(() =>
    setMigrationMachineAddress({
      sourceUrl: URL_BASE,
      sourceId: "",
      serverId: added.server.id,
      address: "203.0.113.7",
    }),
  );
  const other = await asOwner(() =>
    migrationMachines(
      {
        kind: "dokploy" as const,
        baseUrl: "https://dokploy.other.test",
        apiKey: "k",
      },
      TEAM_A,
    ),
  );
  assert.equal(other[0]?.ipAddress, "dokploy.other.test");
});

test("a run needs the machines of ITS services to answer, not every machine", async () => {
  const credential = {
    kind: "dokploy" as const,
    baseUrl: URL_BASE,
    apiKey: CONNECT.apiKey,
  };
  await seedSource(db, "dokploy-host", new URL(URL_BASE).hostname, true);
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({ contractVersion: 1, capabilities: [] }),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<
          typeof import("../../infra/agent-client/connect").connectAgent
        >
      >,
  );
  try {
    await asOwner(() =>
      assertMigrationMachinesReady(credential, ["dok-app-web"]),
    );
    await assert.rejects(
      () =>
        asOwner(() =>
          assertMigrationMachinesReady(credential, ["dok-app-api"]),
        ),
      /eu-1 has no agent/,
    );
  } finally {
    __setAgentConnectorForTest();
  }
});

test("an address one team typed for a machine is known to the next team", async () => {
  await asOwner(() =>
    rememberMigrationMachineAddress(URL_BASE, "", "203.0.113.99"),
  );
  await db.execute(
    `insert into memberships (id, user_id, team_id, role, created_at) values ('mem_u1_b', '${USER_1}', '${TEAM_B}', 'owner', now())`,
  );
  await db.execute(
    `insert into membership_capabilities (membership_id, capability) select 'mem_u1_b', capability from membership_capabilities where membership_id = 'mem_${USER_1}'`,
  );
  const plan = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    scanMigrationSource(CONNECT),
  );
  assert.equal(
    plan.servers.find((s) => s.sourceId === "")?.ipAddress,
    "203.0.113.99",
    "the panel's machine is where it was, whoever asks",
  );
});

test("a source whose team was deleted is adopted by the next migration from that panel", async () => {
  const { serverTeams } = await import("../../db/schema/control-plane/servers");
  const added = await asOwner(() =>
    addServer({
      name: "coolify-host",
      host: "203.0.113.99",
      importOnly: true,
    }),
  );
  await db.delete(serverTeams).where(eq(serverTeams.serverId, added.server.id));
  await asOwner(() =>
    rememberMigrationMachineAddress(URL_BASE, "", "203.0.113.99"),
  );
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  assert.equal(
    plan.servers.find((s) => s.sourceId === "")?.deploServerId,
    added.server.id,
    "the orphan is this team's source again",
  );
});
