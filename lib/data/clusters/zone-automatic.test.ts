import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { encryptSecret } from "../../crypto";
import { nowIso } from "../../ids";
import {
  fakeCloudflare,
  type FakeCloudflare,
} from "../../cloudflare/cloudflare-test-helpers";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusterDnsZones } from "../../db/schema/control-plane/clusters";
import {
  appTunnelDomains,
  dnsProviders,
  dnsProviderTeams,
} from "../../db/schema/control-plane/dns-providers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { QTYPE, type WireAnswer, type WireRecord } from "../../dns/wire";
import { CLUSTER_ZONE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { seedApp } from "../app-graph-test-helpers";
import {
  MEMBERS,
  asAdmin,
  asMember,
  clusterOf,
  db,
  dissolveHarness,
  hosts,
} from "../cluster-dissolve-test-helpers";
import { addDomain, removeDomain } from "../domains/crud";
import { moveDomainToCluster } from "../domains/cluster-answer";
import {
  __resetDnsResolve4ForTest,
  __setDnsResolve4ForTest,
  __setDnsResolve6ForTest,
} from "../domains/dns-check";
import { TEAM_A, USER_1 } from "../identity-test-helpers";
import {
  __resetAgentAddressesForTest,
  __setAgentAddressesForTest,
} from "../servers/addresses";
import { syncClusterAnswerDns } from "./answer-dns";
import { __setDelegationDepsForTest } from "./dns-delegation";
import { clusterDnsView, reconcileClusterZones } from "./dns-zone";
import {
  __setZoneReadyWaitForTest,
  addClusterDnsZone,
  checkClusterDnsZone,
  removeClusterDnsZone,
  renameClusterDnsZone,
} from "./zone-settings";
import { domainZoneTargets, setDomainDnsZone } from "./zone-domains";
import { __setCnameLookupForTest } from "./zone-cnames";
import { setDomainAnswersEverywhere } from "../domains/answer-switch";

// ADR-0049, both paths: under a domain connected for automatic DNS Deplo makes and keeps the cluster's zone and every
// record in Cloudflare; without one, the screens list each record to type and check it.
dissolveHarness();

const PUBLIC: Record<string, string> = {
  srv_2: "203.0.113.2",
  srv_3: "203.0.113.3",
  srv_4: "203.0.113.4",
};

let cf: FakeCloudflare;
let restoreCf = () => {};
// A name server address whose port 53 is closed, and the records typed at a registrar (the manual path).
const closed = new Set<string>();
const registrar: WireRecord[] = [];

const rec = (name: string, type: number, data: string): WireRecord => ({
  name,
  type,
  ttl: 300,
  data,
});
const wire = (over: Partial<WireAnswer>): WireAnswer => ({
  id: 1,
  rcode: 0,
  authoritative: false,
  truncated: false,
  answer: [],
  authority: [],
  additional: [],
  ...over,
});

/** The parent's name servers answer from Cloudflare's records and the registrar's; each cluster server for its zone. */
function parentRecords(): WireRecord[] {
  const byType: Record<string, number> = {
    NS: QTYPE.NS,
    A: QTYPE.A,
    AAAA: QTYPE.AAAA,
  };
  return [
    ...[...cf.records.values()]
      .filter((r) => byType[r.type])
      .map((r) => rec(r.name, byType[r.type], r.content)),
    ...registrar,
  ];
}

beforeEach(async () => {
  closed.clear();
  registrar.length = 0;
  __setAgentAddressesForTest(async (id) => (PUBLIC[id] ? [PUBLIC[id]] : null));
  __setDnsResolve6ForTest(async () => []);
  __setZoneReadyWaitForTest(2, 0);
  for (const id of MEMBERS)
    hosts[id].capabilities.push(CLUSTER_ZONE_CAPABILITY);
  __setDelegationDepsForTest({
    parentOf: async (zone) => ({
      zone: zone.split(".").slice(1).join("."),
      servers: ["parent"],
    }),
    ask: async (server, name, type) => {
      if (server === "parent") {
        const all = parentRecords();
        if (type !== "NS") return wire({});
        const ns = all.filter((r) => r.type === QTYPE.NS && r.name === name);
        return wire({
          authority: ns,
          additional: all.filter(
            (r) =>
              (r.type === QTYPE.A || r.type === QTYPE.AAAA) &&
              ns.some((n) => n.data === r.name),
          ),
        });
      }
      if (closed.has(server)) throw new Error(`${server} did not answer`);
      return wire({
        authoritative: true,
        answer: [rec(name, QTYPE.SOA, `ns1.${name}`)],
      });
    },
  });
});

afterEach(() => {
  restoreCf();
  restoreCf = () => {};
  __setDelegationDepsForTest(null);
  __setZoneReadyWaitForTest(6, 2000);
  __resetAgentAddressesForTest();
  __resetDnsResolve4ForTest();
  __setCnameLookupForTest(null);
});

/** A cluster of three, an App on it, and example.com connected for automatic DNS and shared with team A. */
async function connected() {
  const eu = await clusterOf("eu", MEMBERS);
  await seedApp(db(), { id: "prj_web", slug: "web", serverId: MEMBERS[0] });
  await db()
    .update(appsTable)
    .set({ clusterId: eu.id })
    .where(eq(appsTable.id, "prj_web"));
  ({ cf, restore: restoreCf } = fakeCloudflare());
  await db()
    .insert(dnsProviders)
    .values({
      id: "dnsp_1",
      userId: USER_1,
      provider: "cloudflare",
      zoneName: "example.com",
      zoneId: "zone1",
      accountId: "acct1",
      apiTokenEnc: encryptSecret("tok"),
      shared: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  await db()
    .insert(dnsProviderTeams)
    .values({ providerId: "dnsp_1", teamId: TEAM_A });
  return eu;
}

const records = (name: string) =>
  [...cf.records.values()]
    .filter((r) => r.name === name)
    .map((r) => `${r.type} ${r.content}${r.proxied ? " proxied" : ""}`)
    .sort();

async function domainRow(name: string) {
  const [d] = await db()
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.name, name));
  return d!;
}

const zones = () => db().select().from(clusterDnsZones);

test("an admin's first domain makes the cluster's zone, writes NS, glue and both CNAMEs DNS only, and the cluster answers it", async () => {
  const eu = await connected();
  const d = await asAdmin(() => addDomain("prj_web", "app.example.com"));
  const [zone] = await zones();
  assert.equal(zone.name, "cluster.example.com");
  assert.equal(zone.providerId, "dnsp_1");
  assert.deepEqual(records("cluster.example.com"), [
    "NS ns1.cluster.example.com",
    "NS ns2.cluster.example.com",
    "NS ns3.cluster.example.com",
  ]);
  assert.deepEqual(records("ns1.cluster.example.com"), [
    "A 10.0.0.2",
    "A 203.0.113.2",
  ]);
  assert.deepEqual(records("app.example.com"), [
    "CNAME app-example-com.cluster.example.com",
  ]);
  assert.deepEqual(records("_acme-challenge.app.example.com"), [
    "CNAME _acme-challenge.app-example-com.cluster.example.com",
  ]);
  const row = await domainRow("app.example.com");
  assert.equal(d.answersEverywhere, true);
  assert.equal(row.answersEverywhere, true);
  assert.equal(row.tunnel, null);
  assert.equal(row.dnsZoneId, zone.id);
  assert.equal(row.certProvider, "letsencrypt");
  assert.ok(row.acmeCnameSeenAt);
  assert.equal(row.clusterFallback, null);
  // Every server is handed the name, and once it resolves to them the domain is valid.
  await reconcileClusterZones();
  for (const id of MEMBERS)
    assert.deepEqual(hosts[id].zoneTables.at(-1)!.zones[0].names, [
      "app-example-com.cluster.example.com",
    ]);
  __setDnsResolve4ForTest(async () => Object.values(PUBLIC));
  await syncClusterAnswerDns(eu.id, async () => {});
  assert.equal((await domainRow("app.example.com")).status, "valid");
  // The screens: nothing to type anywhere.
  const view = await asAdmin(() => clusterDnsView(eu.id));
  assert.equal(view.zones[0].keptIn, "example.com");
  assert.equal(
    (await asAdmin(() => domainZoneTargets("prj_web"))).get(d.id)?.kept,
    true,
  );

  // A second domain reuses the zone.
  await asAdmin(() => addDomain("prj_web", "shop.example.com"));
  assert.equal((await zones()).length, 1);
  assert.deepEqual(records("shop.example.com"), [
    "CNAME shop-example-com.cluster.example.com",
  ]);
  // Removing a domain takes both its records out of Cloudflare.
  await asAdmin(() => removeDomain(d.id));
  assert.deepEqual(records("app.example.com"), []);
  assert.deepEqual(records("_acme-challenge.app.example.com"), []);
});

test("the default zone takes a name nothing in Cloudflare uses", async () => {
  await connected();
  cf.records.set("r1", {
    id: "r1",
    zoneId: "zone1",
    type: "A",
    name: "www.cluster.example.com",
    content: "198.51.100.1",
  });
  await asAdmin(() => addDomain("prj_web", "app.example.com"));
  assert.equal((await zones())[0].name, "cluster-2.example.com");
});

test("a member who is not an instance admin gets the tunnel by default, and asking for the cluster says why not", async () => {
  await connected();
  await asMember(() => addDomain("prj_web", "app.example.com"));
  const row = await domainRow("app.example.com");
  assert.equal(row.tunnel, true);
  assert.equal(row.answersEverywhere, false);
  assert.deepEqual(await zones(), []);
  assert.deepEqual(records("app.example.com"), [
    `CNAME ${[...cf.tunnels.keys()][0]}.cfargotunnel.com proxied`,
  ]);
  await assert.rejects(
    asMember(() => addDomain("prj_web", "shop.example.com", { tunnel: false })),
    /only an instance admin can add one/,
  );
  // Once an admin has made the zone, a member's domains use it.
  const { id: clusterId } = await appCluster();
  await asAdmin(() => addClusterDnsZone(clusterId, "go.example.com"));
  await asMember(() => addDomain("prj_web", "blog.example.com"));
  assert.equal((await domainRow("blog.example.com")).answersEverywhere, true);
});

async function appCluster() {
  const [a] = await db()
    .select({ id: appsTable.clusterId })
    .from(appsTable)
    .where(eq(appsTable.id, "prj_web"));
  return { id: a.id! };
}

test("a failed delegation check puts the domain on the tunnel with its reason, and it moves once fixed", async () => {
  await connected();
  closed.add("10.0.0.3").add(PUBLIC.srv_3);
  const d = await asAdmin(() => addDomain("prj_web", "app.example.com"));
  const row = await domainRow("app.example.com");
  assert.equal(row.tunnel, true);
  assert.match(
    row.clusterFallback ?? "",
    /srv_3 \(10\.0\.0\.3\) does not answer for cluster\.example\.com: open port 53, UDP and TCP, on that server/,
  );
  assert.equal(d.clusterFallback, row.clusterFallback);
  // Still closed: the move says so, and the domain stays on its tunnel.
  await assert.rejects(
    asAdmin(() => moveDomainToCluster(d.id)),
    /does not answer for cluster\.example\.com/,
  );
  assert.equal((await domainRow("app.example.com")).tunnel, true);
  closed.clear();
  await asAdmin(() => moveDomainToCluster(d.id));
  const moved = await domainRow("app.example.com");
  assert.equal(moved.tunnel, null);
  assert.equal(moved.answersEverywhere, true);
  assert.equal(moved.clusterFallback, null);
  assert.deepEqual(records("app.example.com"), [
    "CNAME app-example-com.cluster.example.com",
  ]);
  assert.deepEqual(
    await db()
      .select()
      .from(appTunnelDomains)
      .where(eq(appTunnelDomains.domainId, d.id)),
    [],
  );
});

test("the tunnel can still be chosen; a name inside the cluster's zone never is; existing tunnel domains stay as they are", async () => {
  const eu = await connected();
  const chosen = await asAdmin(() =>
    addDomain("prj_web", "app.example.com", { tunnel: true }),
  );
  assert.equal((await domainRow("app.example.com")).tunnel, true);
  assert.deepEqual(await zones(), []);
  await asAdmin(() => addClusterDnsZone(eu.id, "go.example.com"));
  await assert.rejects(
    asAdmin(() =>
      addDomain("prj_web", "shop.go.example.com", { tunnel: true }),
    ),
    /never uses a Cloudflare Tunnel/,
  );
  // As a member too, with no say over the zone: the zone answers it, and nothing is written above it.
  await asMember(() => addDomain("prj_web", "shop.go.example.com"));
  const inside = await domainRow("shop.go.example.com");
  assert.equal(inside.answersEverywhere, true);
  assert.equal(inside.tunnel, null);
  assert.deepEqual(records("shop.go.example.com"), []);
  // The upgrade's sweeps leave the tunnel domain alone.
  const before = records("app.example.com");
  await reconcileClusterZones();
  await syncClusterAnswerDns(eu.id, async () => {});
  const after = await domainRow("app.example.com");
  assert.equal(after.tunnel, true);
  assert.equal(after.answersEverywhere, false);
  assert.deepEqual(records("app.example.com"), before);
  assert.equal(chosen.tunnel, true);
});

test("renaming the zone moves its records in Cloudflare and the domains' CNAMEs; removing it waits for its domains", async () => {
  const eu = await connected();
  const d = await asAdmin(() => addDomain("prj_web", "app.example.com"));
  const [zone] = await zones();
  await assert.rejects(
    asAdmin(() => removeClusterDnsZone(zone.id)),
    /app\.example\.com is answered through cluster\.example\.com/,
  );
  await asAdmin(() => renameClusterDnsZone(zone.id, "apps.example.com"));
  await reconcileClusterZones();
  assert.deepEqual(
    (await zones()).map((z) => z.name),
    ["apps.example.com"],
  );
  assert.deepEqual(records("cluster.example.com"), []);
  assert.deepEqual(records("ns1.cluster.example.com"), []);
  assert.equal(records("apps.example.com").length, 3);
  assert.deepEqual(records("app.example.com"), [
    "CNAME app-example-com.apps.example.com",
  ]);
  assert.deepEqual(records("_acme-challenge.app.example.com"), [
    "CNAME _acme-challenge.app-example-com.apps.example.com",
  ]);
  await asAdmin(() => removeDomain(d.id));
  const [renamed] = await zones();
  await asAdmin(() => removeClusterDnsZone(renamed.id));
  assert.deepEqual(records("apps.example.com"), []);
  assert.equal((await asAdmin(() => clusterDnsView(eu.id))).zones.length, 0);
});

test("by hand: the screens list every record to type, and the checks pass once they exist and say what is missing", async () => {
  const eu = await clusterOf("eu", MEMBERS);
  await seedApp(db(), { id: "prj_web", slug: "web", serverId: MEMBERS[0] });
  await db()
    .update(appsTable)
    .set({ clusterId: eu.id })
    .where(eq(appsTable.id, "prj_web"));
  const zoneId = await asAdmin(() =>
    addClusterDnsZone(eu.id, "go.example.net"),
  );
  await reconcileClusterZones();
  const [zone] = (await asAdmin(() => clusterDnsView(eu.id))).zones;
  assert.equal(zone.keptIn, null);
  assert.deepEqual(
    zone.records.map((r) => `${r.name} ${r.type} ${r.value}`),
    [
      "go.example.net NS ns1.go.example.net",
      "go.example.net NS ns2.go.example.net",
      "go.example.net NS ns3.go.example.net",
      "ns1.go.example.net A 10.0.0.2",
      "ns1.go.example.net A 203.0.113.2",
      "ns2.go.example.net A 10.0.0.3",
      "ns2.go.example.net A 203.0.113.3",
      "ns3.go.example.net A 10.0.0.4",
      "ns3.go.example.net A 203.0.113.4",
    ],
  );
  // Nothing typed yet: the check says what to add.
  const missing = await asAdmin(() => checkClusterDnsZone(zoneId));
  assert.equal(missing.delegated, false);
  assert.deepEqual(missing.problems, [
    "go.example.net is not delegated yet: add its NS records.",
  ]);
  // Typed at the registrar, one A record short.
  for (const r of zone.records.slice(0, -1))
    registrar.push(rec(r.name, r.type === "NS" ? QTYPE.NS : QTYPE.A, r.value));
  const short = await asAdmin(() => checkClusterDnsZone(zoneId));
  assert.deepEqual(short.problems, [
    "Add the A record ns3.go.example.net → 203.0.113.4.",
  ]);
  registrar.push(rec("ns3.go.example.net", QTYPE.A, "203.0.113.4"));
  assert.equal(
    (await asAdmin(() => checkClusterDnsZone(zoneId))).delegated,
    true,
  );

  // A domain outside the zone, with no connected Cloudflare: added as before, then pointed at the zone by hand.
  const d = await asAdmin(() =>
    addDomain("prj_web", "shop.example.org", { certProvider: "letsencrypt" }),
  );
  assert.equal(d.answersEverywhere, undefined);
  assert.equal(d.tunnel, undefined);
  await asAdmin(() => setDomainAnswersEverywhere(d.id, true));
  await asAdmin(() => setDomainDnsZone(d.id, zoneId));
  const shown = (await asAdmin(() => domainZoneTargets("prj_web"))).get(d.id)!;
  assert.equal(shown.target, "shop-example-org.go.example.net");
  assert.equal(shown.kept, undefined);
  assert.deepEqual(shown.cert.check, {
    name: "_acme-challenge.shop.example.org",
    target: "_acme-challenge.shop-example-org.go.example.net",
    seen: false,
  });
  // Its CNAME not there yet: the domain says which one to add.
  __setDnsResolve4ForTest(async () => ["198.51.100.7"]);
  await syncClusterAnswerDns(eu.id, async () => {});
  assert.equal((await domainRow("shop.example.org")).status, "misconfigured");
  // Typed: it resolves to the cluster's servers, and its certificate's CNAME is seen.
  __setDnsResolve4ForTest(async () => Object.values(PUBLIC));
  await syncClusterAnswerDns(eu.id, async () => {});
  assert.equal((await domainRow("shop.example.org")).status, "valid");
  __setCnameLookupForTest(async () => [
    "_acme-challenge.shop-example-org.go.example.net",
  ]);
  await reconcileClusterZones();
  assert.ok((await domainRow("shop.example.org")).acmeCnameSeenAt);
});
