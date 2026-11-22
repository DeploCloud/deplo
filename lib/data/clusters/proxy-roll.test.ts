import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { activities } from "../../db/schema/control-plane/activity";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { serverAddresses } from "../../db/schema/control-plane/servers";
import { nowIso } from "../../ids";
import { applyTraefikConfig } from "../../infra/agent-client/host-ops";
import {
  ADDRESS_PROVE_CAPABILITY,
  CLUSTER_ZONE_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";
import { seedApp, SERVER_1 } from "../app-graph-test-helpers";
import {
  MEMBERS,
  FP,
  asAdmin,
  clusterOf,
  db,
  dissolveHarness,
  hosts,
} from "../cluster-dissolve-test-helpers";
import {
  __resetAgentAddressesForTest,
  __setAgentAddressesForTest,
} from "../servers/addresses";
import { __setAddressProbesForTest } from "../servers/address-checks";
import { syncClusterZone } from "./dns-zone";
import { __resetProxyRoll, proxyRollTiming } from "./proxy-roll";
import { addClusterDnsZone } from "./zone-settings";

// ADR-0049: a cluster member's proxy restarts alone, out of its zone's answers until it serves again.
dissolveHarness();

const timing = { ...proxyRollTiming };
let events: string[];

beforeEach(() => {
  __resetProxyRoll();
  Object.assign(proxyRollTiming, {
    drainMs: 0,
    tableWithinMs: 0,
    answerWithinMs: 0,
    pollMs: 0,
    settleMs: 0,
  });
  __setAgentAddressesForTest(async (id) => [`203.0.113.${id.slice(-1)}`]);
  events = [];
  for (const id of [SERVER_1, ...MEMBERS]) {
    hosts[id].capabilities.push(CLUSTER_ZONE_CAPABILITY);
    hosts[id].proxy.yaml = "services: {}\n";
    hosts[id].extra.traefikConfig = async () => {
      // Who the zone leaves out while this proxy restarts, as each member was last told.
      const out = MEMBERS.map((m) =>
        (hosts[m].zoneTables.at(-1)?.servers ?? [])
          .filter((s) => s.emptying)
          .map((s) => s.fingerprint),
      );
      events.push(`start ${id} out=${JSON.stringify(out)}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end ${id}`);
      hosts[id].proxy.applied++;
      return { ok: true, error: "", composeYaml: "" };
    };
  }
});
afterEach(() => {
  Object.assign(proxyRollTiming, timing);
  __resetAgentAddressesForTest();
  __setAddressProbesForTest(null);
  __resetProxyRoll();
});

async function zoned() {
  const eu = await clusterOf("eu", MEMBERS);
  await seedApp(db(), { id: "prj_web", slug: "web", serverId: MEMBERS[0] });
  await db()
    .update(appsTable)
    .set({ clusterId: eu.id })
    .where(eq(appsTable.id, "prj_web"));
  await db().insert(domainsTable).values({
    id: "d1",
    appId: "prj_web",
    name: "shop.go.example.com",
    status: "valid",
    isPrimary: false,
    ssl: true,
    source: "custom",
    answersEverywhere: true,
    createdAt: nowIso(),
  });
  await asAdmin(() => addClusterDnsZone(eu.id, "go.example.com"));
  await syncClusterZone(eu.id);
  return eu;
}

const outNow = () =>
  MEMBERS.map((m) =>
    (hosts[m].zoneTables.at(-1)?.servers ?? []).filter((s) => s.emptying),
  ).flat();

test("proxies restarted at once on a cluster restart one at a time, each out of every answer meanwhile", async () => {
  await zoned();
  await Promise.all(
    MEMBERS.map((id) => applyTraefikConfig(id, { restartOnly: true })),
  );
  const order = events.map((e) => e.split(" ").slice(0, 2).join(" "));
  for (let i = 0; i < order.length; i += 2) {
    const id = order[i].split(" ")[1];
    assert.equal(order[i], `start ${id}`, `${events}`);
    assert.equal(order[i + 1], `end ${id}`, `${events}`);
    // Every member was told this one, and only this one, is out.
    const out = JSON.parse(events[i].split(" out=")[1]) as string[][];
    for (const told of out) assert.deepEqual(told, [FP[id]], `${events}`);
  }
  assert.equal(order.length, 6);
  // Back in every answer once done.
  assert.deepEqual(outNow(), []);
  for (const id of MEMBERS) assert.equal(hosts[id].proxy.applied, 1, id);
});

test("a server in no cluster restarts at once, and no zone hears of it", async () => {
  await zoned();
  const before = MEMBERS.map((m) => hosts[m].zoneTables.length);
  const res = await applyTraefikConfig(SERVER_1, { restartOnly: true });
  assert.equal(res.ok, true);
  assert.deepEqual(
    MEMBERS.map((m) => hosts[m].zoneTables.length),
    before,
  );
});

test("a member stays out of the answers until its 443 and its name server answer", async () => {
  await zoned();
  const id = MEMBERS[0];
  const address = "2001:db8::2";
  const now = nowIso();
  await db().insert(serverAddresses).values({
    serverId: id,
    address,
    origin: "machine",
    seenAt: now,
    checkedAt: now,
    provenAt: now,
  });
  hosts[id].capabilities.push(ADDRESS_PROVE_CAPABILITY);
  hosts[id].extra.proveAddresses = async () => ({
    proxyCertificateSha256: "c".repeat(64),
    trafficAddresses: [],
    dnsIdent: "ident-2",
  });
  let probes = 0;
  let asked = 0;
  __setAddressProbesForTest({
    tls: async () => {
      probes++;
      // Out of the answers while it does not answer yet.
      assert.deepEqual(
        [...new Set(outNow().map((s) => s.fingerprint))],
        [FP[id]],
      );
      return probes < 3
        ? { ok: false, why: "closed" }
        : { ok: true, value: "c".repeat(64) };
    },
    // Its name server answers once its proxy does, the second time it is asked.
    dns: async () =>
      ++asked < 2
        ? { ok: false, why: "silent" }
        : { ok: true, value: "ident-2" },
  });
  proxyRollTiming.answerWithinMs = 60_000;
  await applyTraefikConfig(id, { restartOnly: true });
  assert.equal(probes, 4);
  assert.equal(asked, 2);
  assert.deepEqual(outNow(), []);
});

test("a member whose proxy never answers is put back, and the cluster's Activity says so", async () => {
  await zoned();
  const id = MEMBERS[1];
  hosts[id].capabilities.push(ADDRESS_PROVE_CAPABILITY);
  hosts[id].extra.proveAddresses = async () => ({
    proxyCertificateSha256: "",
    trafficAddresses: [],
    dnsIdent: "",
  });
  await applyTraefikConfig(id, { restartOnly: true });
  assert.deepEqual(outNow(), []);
  const said = await db().select({ m: activities.message }).from(activities);
  assert.ok(
    said.some((a) => /did not answer within .* of its restart/.test(a.m)),
    JSON.stringify(said),
  );
});
