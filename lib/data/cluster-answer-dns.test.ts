import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { encryptSecret } from "../crypto";
import { nowIso } from "../ids";
import { fakeCloudflare } from "../cloudflare/cloudflare-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { clusterMembers } from "../db/schema/control-plane/clusters";
import {
  dnsProviders,
  domainDnsRecords,
} from "../db/schema/control-plane/dns-providers";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { seedApp } from "./app-graph-test-helpers";
import {
  ANSWER_RECORD_COMMENT,
  clusterAnswerRecordSet,
  syncClusterAnswerDns,
} from "./clusters/answer-dns";
import {
  MEMBERS,
  asAdmin,
  clusterOf,
  db,
  dissolveHarness,
} from "./cluster-dissolve-test-helpers";
import { addClusterDnsZone } from "./clusters/zone-settings";
import { listClusterAnswers } from "./clusters/answers";
import { removeDomain } from "./domains/crud";
import { routableRoutes } from "./domains/routes";
import {
  __resetDnsResolve4ForTest,
  __setDnsResolve4ForTest,
  __setDnsResolve6ForTest,
} from "./domains/dns-check";
import {
  __resetAgentAddressesForTest,
  __setAgentAddressesForTest,
} from "./servers/addresses";
import { TEAM_A, USER_1 } from "./identity-test-helpers";

// ADR-0048 step 3: a domain that answers on every server lists every healthy server, at its provider or by hand.
dissolveHarness();

const PUBLIC: Record<string, string> = {
  srv_2: "10.0.0.2",
  srv_3: "10.0.0.3",
  srv_4: "10.0.0.4",
};

beforeEach(() => {
  __setAgentAddressesForTest(async (id) => (PUBLIC[id] ? [PUBLIC[id]] : null));
  __setDnsResolve6ForTest(async () => []);
});
afterEach(() => {
  __resetAgentAddressesForTest();
  __resetDnsResolve4ForTest();
});

async function answeringApp(clusterId: string) {
  await seedApp(db(), { id: "prj_web", slug: "web", serverId: MEMBERS[0] });
  await db()
    .update(appsTable)
    .set({ clusterId })
    .where(eq(appsTable.id, "prj_web"));
  await db().insert(domainsTable).values({
    id: "dom_1",
    appId: "prj_web",
    name: "app.example.com",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    answersEverywhere: true,
    createdAt: nowIso(),
  });
}

const stopped = (clusterId: string, serverId: string) =>
  db()
    .update(clusterMembers)
    .set({ leaseState: "not_responding" })
    .where(eq(clusterMembers.serverId, serverId));

test("the set is every server the leader hears, and a stopped one drops out", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  const before = await clusterAnswerRecordSet(cluster.id);
  assert.deepEqual(before.a, ["10.0.0.2", "10.0.0.3", "10.0.0.4"]);
  await stopped(cluster.id, "srv_3");
  assert.deepEqual((await clusterAnswerRecordSet(cluster.id)).a, [
    "10.0.0.2",
    "10.0.0.4",
  ]);
});

test("at a connected provider the records become the set, and only Deplo's own records are removed", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  await answeringApp(cluster.id);
  const { cf, restore } = fakeCloudflare();
  try {
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
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    await db().insert(domainDnsRecords).values({
      domainId: "dom_1",
      providerId: "dnsp_1",
      zoneId: "zone1",
      recordId: "rec_old",
      createdAt: nowIso(),
    });
    // What Deplo wrote when the App ran on one server: srv_2 only.
    cf.records.set("rec_old", {
      id: "rec_old",
      zoneId: "zone1",
      type: "A",
      name: "app.example.com",
      content: "10.0.0.2",
      comment: ANSWER_RECORD_COMMENT,
    });
    await syncClusterAnswerDns(cluster.id);
    const a = () =>
      [...cf.records.values()]
        .filter((r) => r.name === "app.example.com" && r.type === "A")
        .map((r) => r.content)
        .sort();
    assert.deepEqual(a(), ["10.0.0.2", "10.0.0.3", "10.0.0.4"]);
    assert.ok(
      [...cf.records.values()].every(
        (r) => r.ttl === undefined || r.ttl === 60,
      ),
    );
    await stopped(cluster.id, "srv_4");
    await syncClusterAnswerDns(cluster.id);
    assert.deepEqual(a(), ["10.0.0.2", "10.0.0.3"]);
    // A record a person wrote is never touched, and the domain says so once.
    cf.records.set("rec_theirs", {
      id: "rec_theirs",
      zoneId: "zone1",
      type: "A",
      name: "app.example.com",
      content: "198.51.100.9",
    });
    await syncClusterAnswerDns(cluster.id);
    await syncClusterAnswerDns(cluster.id);
    assert.ok(cf.records.has("rec_theirs"));
    const said = (await db().select().from(activities)).filter((r) =>
      r.message.includes("Deplo did not write"),
    );
    assert.equal(said.length, 1);
  } finally {
    restore();
  }
});

test("by hand, the domain is misconfigured until it lists every healthy server, and says which to add or remove", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  await answeringApp(cluster.id);
  __setDnsResolve4ForTest(async () => ["10.0.0.2", "198.51.100.9"]);
  await syncClusterAnswerDns(cluster.id);
  const [row] = await db()
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.id, "dom_1"));
  assert.equal(row.status, "misconfigured");
  const [entry] = (await db().select().from(activities)).filter(
    (r) => r.teamId === TEAM_A && r.message.startsWith("app.example.com"),
  );
  assert.equal(
    entry.message,
    "app.example.com must list every server of its cluster that answers: add 10.0.0.3, 10.0.0.4 and remove 198.51.100.9",
  );
  __setDnsResolve4ForTest(async () => ["10.0.0.4", "10.0.0.3", "10.0.0.2"]);
  await syncClusterAnswerDns(cluster.id);
  const [fixed] = await db()
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.id, "dom_1"));
  assert.equal(fixed.status, "valid");
});

// Found on the ADR-0049 lab: a verdict that took a serving domain off its App's routes rendered the App without it
// on every server, a 404 Deplo made itself. A verdict now shows on the domain and only ever adds a route.
test("a zone's domain that serves keeps its route through every negative verdict; only a first valid one routes", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  await answeringApp(cluster.id);
  await db()
    .update(domainsTable)
    .set({ name: "app.go.example.com" })
    .where(eq(domainsTable.id, "dom_1"));
  await asAdmin(() => addClusterDnsZone(cluster.id, "go.example.com"));
  const row = async () =>
    (
      await db()
        .select({ status: domainsTable.status, ssl: domainsTable.ssl })
        .from(domainsTable)
        .where(eq(domainsTable.id, "dom_1"))
    )[0];
  const routes = async () =>
    (await routableRoutes("prj_web")).map((r) => r.name);
  const answered = async () =>
    (await listClusterAnswers(cluster.id)).flatMap((a) => a.hosts);
  const warned = async () =>
    (await db().select().from(activities)).some((a) =>
      a.message.startsWith("app.go.example.com does not reach the cluster"),
    );
  const routed: string[] = [];
  const sync = () =>
    syncClusterAnswerDns(cluster.id, async (id) => void routed.push(id));
  const kept = async (status: string) => {
    assert.deepEqual(await row(), { status, ssl: true });
    assert.deepEqual(await routes(), ["app.go.example.com"]);
    assert.deepEqual(await answered(), ["app.go.example.com"]);
    assert.deepEqual(routed, [], "nothing rendered without it");
  };

  // A lookup that failed: no verdict at all.
  __setDnsResolve4ForTest(async () => {
    throw Object.assign(new Error("queryA ESERVFAIL"), { code: "ESERVFAIL" });
  });
  await sync();
  await kept("valid");
  assert.equal(await warned(), false);

  // Pending: the name resolves to nothing.
  __setDnsResolve4ForTest(async () => {
    throw Object.assign(new Error("queryA ENODATA"), { code: "ENODATA" });
  });
  await sync();
  await kept("pending");
  assert.equal(await warned(), true, "the warning shows");

  // Misconfigured: an address that is no member's.
  __setDnsResolve4ForTest(async () => ["10.0.0.2", "198.51.100.9"]);
  await sync();
  await kept("misconfigured");

  // A member just stopped: its IPv6 is unknown while the zone still answers it.
  __setAgentAddressesForTest(async (id) =>
    id === "srv_4"
      ? null
      : PUBLIC[id]
        ? [PUBLIC[id], `2001:db8::${id.slice(-1)}`]
        : null,
  );
  __setDnsResolve4ForTest(async () => ["10.0.0.2", "10.0.0.3", "10.0.0.4"]);
  __setDnsResolve6ForTest(async () => ["2001:db8::2", "2001:db8::4"]);
  await sync();
  await kept("valid");

  // A domain that never served: pending, then valid, is routed once.
  await db()
    .update(domainsTable)
    .set({ status: "pending", ssl: false })
    .where(eq(domainsTable.id, "dom_1"));
  __setDnsResolve4ForTest(async () => []);
  await sync();
  assert.deepEqual(
    await routes(),
    [],
    "not routed before it reaches the cluster",
  );
  __setDnsResolve4ForTest(async () => ["10.0.0.2", "10.0.0.3"]);
  await sync();
  assert.deepEqual(await row(), { status: "valid", ssl: true });
  assert.deepEqual(routed, ["prj_web"]);
  assert.deepEqual(await routes(), ["app.go.example.com"]);

  // A person removing it still removes it.
  await asAdmin(() => removeDomain("dom_1"));
  assert.deepEqual(await routes(), []);
  assert.deepEqual(await answered(), []);
});

test("by hand, a served domain that no longer lists every server keeps its route and says what to change", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  await answeringApp(cluster.id);
  const routed: string[] = [];
  __setDnsResolve4ForTest(async () => ["10.0.0.2", "198.51.100.9"]);
  await syncClusterAnswerDns(cluster.id, async (id) => void routed.push(id));
  const [row] = await db()
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.id, "dom_1"));
  assert.equal(row.status, "misconfigured");
  assert.equal(row.ssl, true);
  assert.deepEqual(
    (await routableRoutes("prj_web")).map((r) => r.name),
    ["app.example.com"],
  );
  assert.deepEqual(routed, []);
});
