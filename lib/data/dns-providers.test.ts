import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { domainDnsRecords } from "../db/schema/control-plane/dns-providers";
import {
  fakeCloudflare,
  type FakeCloudflare,
} from "../cloudflare/cloudflare-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import {
  appTunnelService,
  hasTunnelConnector,
  withTunnelConnector,
} from "../deploy/panel-tunnel-stack";
import { domainTlsConfig } from "../deploy/domains";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { TRUNCATE_IDENTITY } from "./identity-test-helpers";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains/dns-check";
import {
  addDomain,
  listDomains,
  removeDomain,
  updateDomain,
} from "./domains/crud";
import {
  checkDnsProvider,
  listMyDnsProviders,
  removeDnsProvider,
  saveDnsProvider,
  updateDnsProvider,
} from "./dns-providers/store";
import {
  autoDnsZones,
  deleteReleasedDns,
  takeAppDns,
} from "./dns-providers/provision";
import { restoreTunnelConnectors } from "./dns-providers/tunnels";
import { apps as appsTable } from "../db/schema/control-plane/apps";

let db: TestDb;
let pg: PGlite;
let cf: FakeCloudflare;
let restoreFetch = () => {};
let host: { yaml: string; applied: number };

const OWNER = "owner1";
const MATE = "mate2";
const TOKEN = "cf-token-0123456789";
const STACK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
networks:
  deplo:
    external: true
`;

const as = <T>(userId: string, fn: () => Promise<T>, teamId = TEAM_A) =>
  runWithIdentity({ userId, teamId }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setDnsResolve4ForTest(async () => []);
});

after(async () => {
  __resetTestDb();
  __resetDnsResolve4ForTest();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec("truncate table dns_providers restart identity cascade;");
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: MATE, teamId: TEAM_A, role: "member" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1" });
  host = { yaml: STACK, applied: 0 };
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({ capabilities: ["hostops"] }),
      hostInfo: async () => ({ traefikComposeYaml: host.yaml }),
      traefikConfig: async (req: { composeYaml: string }) => {
        if (req.composeYaml) host.yaml = req.composeYaml;
        host.applied++;
        return { ok: true, error: "" };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  ({ cf, restore: restoreFetch } = fakeCloudflare());
});

afterEach(() => {
  restoreFetch();
  __setAgentConnectorForTest();
});

const connect = (shared = false, teamIds = [TEAM_A]) =>
  as(OWNER, () =>
    saveDnsProvider({
      provider: "cloudflare",
      zone: "Example.com",
      apiToken: TOKEN,
      teamIds,
      shared,
    }),
  );

test("checking a token finds the zone, and refuses a name inside it", async () => {
  const checked = await as(OWNER, () =>
    checkDnsProvider({
      provider: "cloudflare",
      zone: "example.com",
      apiToken: TOKEN,
    }),
  );
  assert.deepEqual(checked, { zoneName: "example.com", tunnels: true });
  await assert.rejects(
    () =>
      as(OWNER, () =>
        checkDnsProvider({
          provider: "cloudflare",
          zone: "app.example.com",
          apiToken: TOKEN,
        }),
      ),
    /part of example\.com/,
  );
});

test("a connected domain belongs to its owner, and only teams they manage domains in", async () => {
  const saved = await connect();
  assert.equal(saved.zoneName, "example.com");
  assert.deepEqual(
    saved.teams.map((t) => t.id),
    [TEAM_A],
  );
  assert.deepEqual(
    await as(MATE, () => listMyDnsProviders()),
    [],
    "a teammate never sees it",
  );
  await assert.rejects(
    () => connect(false, [TEAM_B]),
    /where you manage domains/,
  );
  await assert.rejects(
    () =>
      as(MATE, () =>
        updateDnsProvider({ id: saved.id, teamIds: [TEAM_A], shared: true }),
      ),
    /not found/,
  );
});

test("an API token cannot connect a DNS provider", async () => {
  await assert.rejects(
    () =>
      runWithIdentity(
        {
          userId: OWNER,
          teamId: TEAM_A,
          token: { id: "tok", scope: null },
        } as never,
        () =>
          saveDnsProvider({
            provider: "cloudflare",
            zone: "example.com",
            apiToken: TOKEN,
            teamIds: [TEAM_A],
            shared: false,
          }),
      ),
    /API token/,
  );
});

test("a domain under the zone gets an A record, removed with the domain", async () => {
  await connect();
  const dom = await as(OWNER, () => addDomain("prj_1", "app.example.com", {}));
  const records = [...cf.records.values()];
  assert.equal(records.length, 1);
  assert.equal(records[0]!.type, "A");
  assert.equal(records[0]!.content, "10.0.0.1");
  assert.equal(records[0]!.proxied, false);
  const listed = await as(OWNER, () => listDomains("prj_1"));
  assert.equal(listed[0]!.autoDns, true);

  await as(OWNER, () => addDomain("prj_1", "other.org", {}));
  assert.equal(cf.records.size, 1, "a name outside the zone is left alone");

  await as(OWNER, () => removeDomain(dom.id));
  assert.equal(cf.records.size, 0);
});

test("renaming moves the record to the new name", async () => {
  await connect();
  const dom = await as(OWNER, () => addDomain("prj_1", "a.example.com", {}));
  await as(OWNER, () => updateDomain(dom.id, { name: "b.example.com" }));
  const names = [...cf.records.values()].map((r) => r.name);
  assert.deepEqual(names, ["b.example.com"]);
});

test("a name someone else already uses in Cloudflare is refused, and nothing is saved", async () => {
  await connect();
  cf.records.set("x", {
    id: "x",
    zoneId: "zone1",
    type: "A",
    name: "taken.example.com",
    content: "198.51.100.7",
  });
  await assert.rejects(
    () => as(OWNER, () => addDomain("prj_1", "taken.example.com", {})),
    /already has a A record/,
  );
  assert.equal((await db.select().from(domainsTable)).length, 0);
});

test("a private connection serves only its owner; sharing opens it to the team", async () => {
  const saved = await connect();
  assert.deepEqual(await as(MATE, () => autoDnsZones()), []);
  await as(MATE, () => addDomain("prj_1", "mate.example.com", {}));
  assert.equal(
    cf.records.size,
    0,
    "the teammate does not use the owner's token",
  );

  await as(OWNER, () =>
    updateDnsProvider({ id: saved.id, teamIds: [TEAM_A], shared: true }),
  );
  assert.deepEqual(
    (await as(MATE, () => autoDnsZones())).map((z) => z.zoneName),
    ["example.com"],
  );
  await as(MATE, () => addDomain("prj_1", "mate2.example.com", {}));
  assert.equal(cf.records.size, 1);
});

test("a tunnel domain gets a connector, an ingress rule and a CNAME", async () => {
  const saved = await connect();
  const dom = await as(OWNER, () =>
    addDomain("prj_1", "app.example.com", {
      tunnel: true,
      certProvider: "letsencrypt",
    }),
  );
  assert.equal(dom.tunnel, true);
  assert.equal(dom.proxied, true);
  assert.deepEqual(domainTlsConfig(dom), {
    entrypoint: "web",
    tls: false,
    certResolver: "",
  });

  assert.equal(cf.tunnels.size, 1);
  const tunnel = [...cf.tunnels.entries()][0]!;
  assert.deepEqual(tunnel[1].ingress, [
    { hostname: "app.example.com", service: "http://deplo-traefik:80" },
    { service: "http_status:404" },
  ]);
  const record = [...cf.records.values()][0]!;
  assert.equal(record.type, "CNAME");
  assert.equal(record.content, `${tunnel[0]}.cfargotunnel.com`);
  assert.ok(hasTunnelConnector(host.yaml, appTunnelService(saved.id)));

  await as(OWNER, () =>
    addDomain("prj_1", "two.example.com", { tunnel: true }),
  );
  assert.equal(cf.tunnels.size, 1, "one tunnel per server");
  assert.equal(host.applied, 1, "the proxy restarts only for the first");

  await as(OWNER, () => removeDomain(dom.id));
  assert.deepEqual(
    (cf.tunnels.get(tunnel[0])!.ingress as { hostname?: string }[]).map(
      (r) => r.hostname,
    ),
    ["two.example.com", undefined],
  );

  const warning = await as(OWNER, () => removeDnsProvider(saved.id));
  assert.equal(warning, null);
  assert.equal(cf.tunnels.size, 0);
  assert.equal(cf.records.size, 0);
  assert.ok(!hasTunnelConnector(host.yaml, appTunnelService(saved.id)));
  assert.equal((await db.select().from(domainDnsRecords)).length, 0);
});

test("a tunnel needs a connected domain that covers the name", async () => {
  await assert.rejects(
    () =>
      as(OWNER, () => addDomain("prj_1", "app.example.com", { tunnel: true })),
    /not in a domain connected for automatic DNS/,
  );
  const rows = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.name, "app.example.com"));
  assert.equal(rows.length, 0);
});

test("a record that was already there is never deleted", async () => {
  await connect();
  cf.records.set("pre", {
    id: "pre",
    zoneId: "zone1",
    type: "A",
    name: "kept.example.com",
    content: "10.0.0.1",
  });
  const dom = await as(OWNER, () => addDomain("prj_1", "kept.example.com", {}));
  assert.equal(cf.records.size, 1, "nothing new was made");
  await as(OWNER, () => removeDomain(dom.id));
  assert.ok(cf.records.has("pre"), "the user's own record stays");
});

test("a tunnel CNAME that was already there stays when the domain goes", async () => {
  await connect();
  const first = await as(OWNER, () =>
    addDomain("prj_1", "app.example.com", { tunnel: true }),
  );
  const cname = [...cf.records.values()][0]!;
  // Deplo forgets it made the record: from here on it is the user's.
  await db
    .update(domainDnsRecords)
    .set({ created: false })
    .where(eq(domainDnsRecords.domainId, first.id));
  await as(OWNER, () => removeDomain(first.id));
  assert.ok(cf.records.has(cname.id));
});

test("a record still used by another domain on the same name moves to it", async () => {
  await connect();
  const root = await as(OWNER, () => addDomain("prj_1", "app.example.com", {}));
  const api = await as(OWNER, () =>
    addDomain("prj_1", "app.example.com", { pathPrefix: "/api" }),
  );
  assert.equal(cf.records.size, 1);
  await as(OWNER, () => removeDomain(root.id));
  assert.equal(cf.records.size, 1, "the /api domain still needs it");
  await as(OWNER, () => removeDomain(api.id));
  assert.equal(cf.records.size, 0, "the last one takes it along");
});

test("deleting an app deletes only the records Deplo created for it", async () => {
  await connect();
  cf.records.set("pre", {
    id: "pre",
    zoneId: "zone1",
    type: "A",
    name: "mine.example.com",
    content: "10.0.0.1",
  });
  await as(OWNER, () => addDomain("prj_1", "made.example.com", {}));
  await as(OWNER, () => addDomain("prj_1", "mine.example.com", {}));
  assert.equal(cf.records.size, 2);

  const held = await takeAppDns(["prj_1"]);
  await db.delete(appsTable).where(eq(appsTable.id, "prj_1"));
  assert.equal(await deleteReleasedDns(held), null);
  assert.deepEqual([...cf.records.keys()], ["pre"]);
});

test("a connector the proxy stack lost comes back on its own", async () => {
  const saved = await connect();
  await as(OWNER, () =>
    addDomain("prj_1", "app.example.com", { tunnel: true }),
  );
  const service = appTunnelService(saved.id);
  host.yaml = withTunnelConnector(host.yaml, service, null);
  assert.ok(!hasTunnelConnector(host.yaml, service));

  assert.equal(await restoreTunnelConnectors(), 1);
  assert.ok(hasTunnelConnector(host.yaml, service));
  assert.equal(
    await restoreTunnelConnectors(),
    0,
    "nothing to do the second time",
  );
});
