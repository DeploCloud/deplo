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
import { addClusterDnsZone } from "./clusters/dns-zone";
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

// Found on the ADR-0049 lab: a name server that had just stopped failed the lookup, which read as "not delegated",
// and the failover's reroute then left the App's domain out on every server that still ran it.
test("a lookup that fails says nothing about a zone's domain; a real change routes its App again", async () => {
  const cluster = await clusterOf("eu", MEMBERS);
  await answeringApp(cluster.id);
  await db()
    .update(domainsTable)
    .set({ name: "app.go.example.com" })
    .where(eq(domainsTable.id, "dom_1"));
  await asAdmin(() => addClusterDnsZone(cluster.id, "go.example.com"));
  const status = async () =>
    (
      await db()
        .select({ s: domainsTable.status })
        .from(domainsTable)
        .where(eq(domainsTable.id, "dom_1"))
    )[0].s;
  const routed: string[] = [];
  const reroutes = () => routed.length;
  const sync = () =>
    syncClusterAnswerDns(cluster.id, async (id) => void routed.push(id));

  __setDnsResolve4ForTest(async () => {
    throw Object.assign(new Error("queryA ESERVFAIL"), { code: "ESERVFAIL" });
  });
  await sync();
  assert.equal(await status(), "valid");
  assert.equal(reroutes(), 0);
  assert.ok(
    !(await db().select().from(activities)).some((a) =>
      a.message.includes("does not reach the cluster"),
    ),
  );

  __setDnsResolve4ForTest(async () => {
    throw Object.assign(new Error("queryA ENODATA"), { code: "ENODATA" });
  });
  await sync();
  assert.equal(await status(), "pending");
  const after = reroutes();
  assert.ok(after > 0, "a domain no longer valid is routed again");

  __setDnsResolve4ForTest(async () => ["10.0.0.2", "10.0.0.3"]);
  await sync();
  assert.equal(await status(), "valid");
  assert.ok(reroutes() > after, "and once valid again");
  assert.deepEqual([...new Set(routed)], ["prj_web"]);

  // A member just stopped: its agent is away, so its IPv6 is unknown, and the zone still answers it for a while.
  const before = reroutes();
  __setAgentAddressesForTest(async (id) =>
    id === "srv_4"
      ? null
      : PUBLIC[id]
        ? [PUBLIC[id], `2001:db8::${id.slice(-1)}`]
        : null,
  );
  __setDnsResolve4ForTest(async () => ["10.0.0.2", "10.0.0.3", "10.0.0.4"]);
  __setDnsResolve6ForTest(async () => [
    "2001:db8::2",
    "2001:db8::3",
    "2001:db8::4",
  ]);
  await sync();
  assert.equal(await status(), "valid");
  assert.equal(reroutes(), before, "nothing is routed again");
});
