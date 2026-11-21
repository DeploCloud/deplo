import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";

import { encryptSecret } from "../../crypto";
import { nowIso } from "../../ids";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterMembers,
  clusterNameServers,
  clusterZoneStates,
} from "../../db/schema/control-plane/clusters";
import {
  dnsProviders,
  domainDnsRecords,
} from "../../db/schema/control-plane/dns-providers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { CLUSTER_ZONE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { seedApp } from "../app-graph-test-helpers";
import {
  MEMBERS,
  FP,
  asAdmin,
  asMember,
  clusterOf,
  db,
  dissolveHarness,
  hosts,
} from "../cluster-dissolve-test-helpers";
import { nativeStatus } from "./answer-dns";
import {
  addClusterDnsZone,
  clusterDnsView,
  reconcileClusterZones,
  removeClusterDnsZone,
  setClusterDnsTimes,
  syncClusterZone,
} from "./dns-zone";
import {
  __setApexCheckForTest,
  domainZoneTargets,
  setDomainDnsZone,
} from "./zone-domains";
import {
  __resetAgentAddressesForTest,
  __setAgentAddressesForTest,
} from "../servers/addresses";
import { USER_1 } from "../identity-test-helpers";

// ADR-0049 phase 1: a cluster answers for its own DNS zone; Deplo hands every member the zone and picks name servers.
dissolveHarness();

const PUBLIC: Record<string, string> = {
  srv_2: "203.0.113.2",
  srv_3: "203.0.113.3",
  srv_4: "203.0.113.4",
};

beforeEach(() => {
  __setAgentAddressesForTest(async (id) => (PUBLIC[id] ? [PUBLIC[id]] : null));
  __setApexCheckForTest(async (name) => name === "example.org");
  for (const id of MEMBERS)
    hosts[id].capabilities.push(CLUSTER_ZONE_CAPABILITY);
});
afterEach(() => {
  __resetAgentAddressesForTest();
  __setApexCheckForTest(null);
});

const lastTable = (id: string) => hosts[id].zoneTables.at(-1);

async function nameServers(clusterId: string) {
  const rows = await db()
    .select()
    .from(clusterNameServers)
    .where(eq(clusterNameServers.clusterId, clusterId))
    .orderBy(clusterNameServers.position);
  return rows.map((r) => r.serverId);
}

async function answeringDomain(clusterId: string, id: string, name: string) {
  if (
    !(await db().select().from(appsTable).where(eq(appsTable.id, "prj_web")))
      .length
  ) {
    await seedApp(db(), { id: "prj_web", slug: "web", serverId: MEMBERS[0] });
    await db()
      .update(appsTable)
      .set({ clusterId })
      .where(eq(appsTable.id, "prj_web"));
  }
  await db().insert(domainsTable).values({
    id,
    appId: "prj_web",
    name,
    status: "pending",
    isPrimary: false,
    ssl: true,
    source: "custom",
    answersEverywhere: true,
    createdAt: nowIso(),
  });
}

test("an admin delegates a zone; a bad, taken or overlapping one is refused, and nobody else may", async () => {
  const eu = await clusterOf("eu", MEMBERS);
  const us = await clusterOf("us", []);
  await asAdmin(() => addClusterDnsZone(eu.id, "Go.Example.com."));
  await assert.rejects(
    asAdmin(() => addClusterDnsZone(eu.id, "not a domain")),
    /is not a domain/,
  );
  await assert.rejects(
    asAdmin(() => addClusterDnsZone(us.id, "go.example.com")),
    /already answered by cluster eu/,
  );
  await assert.rejects(
    asAdmin(() => addClusterDnsZone(us.id, "a.go.example.com")),
    /overlaps go.example.com/,
  );
  await assert.rejects(
    asAdmin(() => addClusterDnsZone(us.id, "example.com")),
    /overlaps go.example.com/,
  );
  await assert.rejects(
    asMember(() => addClusterDnsZone(eu.id, "other.example.net")),
  );
  const view = await asAdmin(() => clusterDnsView(eu.id));
  assert.deepEqual(
    view.zones.map((z) => z.name),
    ["go.example.com"],
  );
});

test("every member is handed the zone under its own certificate; the name servers are those that answer", async () => {
  const eu = await clusterOf("eu", MEMBERS);
  await answeringDomain(eu.id, "dom_in", "shop.go.example.com");
  await answeringDomain(eu.id, "dom_out", "shop.example.com");
  await asAdmin(() => addClusterDnsZone(eu.id, "go.example.com"));
  const [zone] = (await asAdmin(() => clusterDnsView(eu.id))).zones;
  await asAdmin(() => setDomainDnsZone("dom_out", zone.id));
  await syncClusterZone(eu.id);
  for (const id of MEMBERS) {
    const t = lastTable(id)!;
    assert.equal(t.selfFingerprint, FP[id]);
    assert.deepEqual(t.zones, [
      {
        name: "go.example.com",
        names: ["shop-example-com.go.example.com", "shop.go.example.com"],
      },
    ]);
    assert.deepEqual(
      t.servers.map((s) => [s.fingerprint, s.addresses]),
      MEMBERS.map((m, i) => [FP[m], [`10.0.0.${i + 2}`, PUBLIC[m]]]),
    );
    assert.deepEqual(
      t.nameServers,
      MEMBERS.map((m) => FP[m]),
    );
    assert.equal(t.answerTtlSeconds, 30);
    assert.equal(t.dropAfterSeconds, 10);
  }
  assert.deepEqual(await nameServers(eu.id), MEMBERS);
  const view = await asAdmin(() => clusterDnsView(eu.id));
  assert.deepEqual(
    view.zones[0].records.map((r) => `${r.name} ${r.type} ${r.value}`),
    [
      "go.example.com NS ns1.go.example.com",
      "go.example.com NS ns2.go.example.com",
      "go.example.com NS ns3.go.example.com",
      "ns1.go.example.com A 10.0.0.2",
      "ns1.go.example.com A 203.0.113.2",
      "ns2.go.example.com A 10.0.0.3",
      "ns2.go.example.com A 203.0.113.3",
      "ns3.go.example.com A 10.0.0.4",
      "ns3.go.example.com A 203.0.113.4",
    ],
  );
  assert.deepEqual(
    view.servers.map((s) => [s.serverId, s.serving, s.state]),
    MEMBERS.map((m) => [m, true, "answer"]),
  );
  // What the domains page shows: nothing to add for a name in the zone, one CNAME for the other.
  const targets = await asAdmin(() => domainZoneTargets("prj_web"));
  assert.deepEqual(targets.get("dom_in"), {
    zone: "go.example.com",
    target: null,
    cert: { mode: "http", check: null },
  });
  assert.deepEqual(targets.get("dom_out"), {
    zone: "go.example.com",
    target: "shop-example-com.go.example.com",
    cert: {
      mode: "http",
      check: {
        name: "_acme-challenge.shop.example.com",
        target: "_acme-challenge.shop-example-com.go.example.com",
        seen: false,
      },
    },
  });
  // No server takes checks over DNS here: nothing is set through the zone.
  for (const id of MEMBERS) {
    assert.deepEqual(lastTable(id)!.challenges, []);
    assert.deepEqual(lastTable(id)!.certificates, []);
  }
});

test("a server whose port 53 is taken, or whose agent is too old, is no name server; the chosen ones keep their place", async () => {
  const eu = await clusterOf("eu", MEMBERS);
  hosts.srv_2.zoneReport = () => ({
    listening: [],
    problem: "port 53 on 203.0.113.2 is taken by another program",
    state: "answer",
    answering: [],
    heard: 3,
  });
  hosts.srv_4.capabilities = hosts.srv_4.capabilities.filter(
    (c) => c !== CLUSTER_ZONE_CAPABILITY,
  );
  await asAdmin(() => addClusterDnsZone(eu.id, "go.example.com"));
  await syncClusterZone(eu.id);
  assert.deepEqual(await nameServers(eu.id), ["srv_3"]);
  assert.equal(hosts.srv_4.zoneTables.length, 0);
  const view = await asAdmin(() => clusterDnsView(eu.id));
  const state = Object.fromEntries(
    view.servers.map((s) => [s.serverId, [s.serving, s.state, s.problem]]),
  );
  assert.deepEqual(state.srv_2, [
    false,
    "answer",
    "port 53 on 203.0.113.2 is taken by another program",
  ]);
  assert.equal(state.srv_4[1], "unsupported");
  // srv_2 is fixed: it joined first, but takes the free place rather than push srv_3 out of ns1.
  hosts.srv_2.zoneReport = () => ({
    listening: ["203.0.113.2:53"],
    problem: "",
    state: "answer",
    answering: [],
    heard: 3,
  });
  await syncClusterZone(eu.id);
  assert.deepEqual(await nameServers(eu.id), ["srv_3", "srv_2"]);
  assert.deepEqual(lastTable("srv_3")!.nameServers, [FP.srv_3, FP.srv_2]);
  // An agent that does not answer for a while keeps its place: the registrar's records stay right.
  hosts.srv_3.unreachable = true;
  await syncClusterZone(eu.id);
  assert.deepEqual(await nameServers(eu.id), ["srv_3", "srv_2"]);
});

test("a server that leaves the cluster is told to stop; removing the last zone stops every one", async () => {
  const eu = await clusterOf("eu", MEMBERS);
  await asAdmin(() => addClusterDnsZone(eu.id, "go.example.com"));
  await syncClusterZone(eu.id);
  await db().delete(clusterMembers).where(eq(clusterMembers.serverId, "srv_4"));
  await syncClusterZone(eu.id);
  assert.deepEqual(lastTable("srv_4")!.zones, []);
  assert.deepEqual(
    lastTable("srv_2")!.servers.map((s) => s.fingerprint),
    [FP.srv_2, FP.srv_3],
  );
  const gone = await db()
    .select()
    .from(clusterZoneStates)
    .where(
      and(
        eq(clusterZoneStates.clusterId, eu.id),
        eq(clusterZoneStates.serverId, "srv_4"),
      ),
    );
  assert.equal(gone.length, 0);
  const zone = (await asAdmin(() => clusterDnsView(eu.id))).zones[0];
  await asAdmin(() => removeClusterDnsZone(zone.id));
  await reconcileClusterZones();
  assert.deepEqual(lastTable("srv_2")!.zones, []);
  assert.deepEqual(lastTable("srv_3")!.zones, []);
  assert.equal((await db().select().from(clusterZoneStates)).length, 0);
});

test("the two times keep their ranges and reach every member", async () => {
  const eu = await clusterOf("eu", MEMBERS);
  await asAdmin(() => addClusterDnsZone(eu.id, "go.example.com"));
  await assert.rejects(
    asAdmin(() => setClusterDnsTimes(eu.id, 5, 10)),
    /10 to 300 seconds/,
  );
  await assert.rejects(
    asAdmin(() => setClusterDnsTimes(eu.id, 30, 90)),
    /5 to 60 seconds/,
  );
  await assert.rejects(asMember(() => setClusterDnsTimes(eu.id, 60, 20)));
  await asAdmin(() => setClusterDnsTimes(eu.id, 60, 20));
  await syncClusterZone(eu.id);
  assert.equal(lastTable("srv_2")!.answerTtlSeconds, 60);
  assert.equal(lastTable("srv_2")!.dropAfterSeconds, 20);
});

test("a domain points at the zone only when it can: on every server, of this cluster, not a bare domain, not at a provider", async () => {
  const eu = await clusterOf("eu", MEMBERS);
  const us = await clusterOf("us", []);
  await asAdmin(() => addClusterDnsZone(eu.id, "go.example.com"));
  await asAdmin(() => addClusterDnsZone(us.id, "us.example.net"));
  const [zone] = (await asAdmin(() => clusterDnsView(eu.id))).zones;
  const [usZone] = (await asAdmin(() => clusterDnsView(us.id))).zones;
  await answeringDomain(eu.id, "dom_1", "shop.example.com");
  await assert.rejects(
    asAdmin(() => setDomainDnsZone("dom_1", usZone.id)),
    /not one of this App's cluster/,
  );
  await db()
    .update(domainsTable)
    .set({ answersEverywhere: false })
    .where(eq(domainsTable.id, "dom_1"));
  await assert.rejects(
    asAdmin(() => setDomainDnsZone("dom_1", zone.id)),
    /Answer on every server/,
  );
  await db()
    .update(domainsTable)
    .set({ answersEverywhere: true })
    .where(eq(domainsTable.id, "dom_1"));
  await answeringDomain(eu.id, "dom_apex", "example.org");
  await assert.rejects(
    asAdmin(() => setDomainDnsZone("dom_apex", zone.id)),
    /bare domain.*ALIAS record/,
  );
  await db()
    .insert(dnsProviders)
    .values({
      id: "dnsp_1",
      userId: USER_1,
      provider: "cloudflare",
      zoneName: "example.com",
      zoneId: "z1",
      accountId: "a1",
      apiTokenEnc: encryptSecret("tok"),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  await answeringDomain(eu.id, "dom_cf", "cf.example.com");
  await db().insert(domainDnsRecords).values({
    domainId: "dom_cf",
    providerId: "dnsp_1",
    zoneId: "z1",
    recordId: "r1",
    createdAt: nowIso(),
  });
  await assert.rejects(
    asAdmin(() => setDomainDnsZone("dom_cf", zone.id)),
    /connected DNS provider/,
  );
  await asAdmin(() => setDomainDnsZone("dom_1", zone.id));
  await asAdmin(() => setDomainDnsZone("dom_1", null));
  const [row] = await db()
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.id, "dom_1"));
  assert.equal(row.dnsZoneId, null);
});

test("a domain answered by the zone is valid when it resolves to the cluster's servers only", () => {
  const members = {
    addresses: new Set(["203.0.113.2", "203.0.113.3", "2001:db8::2"]),
    v6Known: true,
  };
  assert.equal(nativeStatus([], members), "pending");
  assert.equal(nativeStatus(["203.0.113.3"], members), "valid");
  assert.equal(
    nativeStatus(["203.0.113.3", "198.51.100.9"], members),
    "misconfigured",
  );
  assert.equal(
    nativeStatus(["203.0.113.3", "2001:db8::9"], members),
    "misconfigured",
  );
  // Found on the ADR-0049 lab: a server just stopped is still answered, and only its agent knows its IPv6.
  const away = { ...members, v6Known: false };
  assert.equal(nativeStatus(["203.0.113.3", "2001:db8::9"], away), "valid");
  assert.equal(
    nativeStatus(["203.0.113.3", "198.51.100.9"], away),
    "misconfigured",
  );
  assert.equal(
    nativeStatus(["2001:db8::9"], away),
    null,
    "nothing left to judge",
  );
});
