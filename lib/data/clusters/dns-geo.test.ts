import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { gunzipSync } from "node:zlib";

import { nowIso } from "../../ids";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { geoBundleFiles, writeGeoBundle } from "../../geo/geo-test-helpers";
import { __resetShippedGeoForTest, geoAgeMonths } from "../../geo/shipped";
import { GeoTable } from "../../geo/table";
import {
  CLUSTER_ZONE_CAPABILITY,
  CLUSTER_ZONE_GEO_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";
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
import { clusterDnsView, syncClusterZone } from "./dns-zone";
import { addClusterDnsZone, placeClusterServer } from "./zone-settings";
import { findCities } from "./server-place";
import {
  __resetAgentAddressesForTest,
  __setAgentAddressesForTest,
} from "../servers/addresses";

// ADR-0049 phase 2: each server's place goes to its agent with the zone, and the release's location table to the
// agents that place visitors with it.
dissolveHarness();

// In the fixture's table srv_2 is in Milan, srv_3 in New York and srv_4 has no place.
const PUBLIC: Record<string, string> = {
  srv_2: "198.51.100.2",
  srv_3: "203.0.113.3",
  srv_4: "192.0.2.4",
};

function geoDir(files = geoBundleFiles()): string {
  const dir = mkdtempSync(join(tmpdir(), "deplo-geo-"));
  writeGeoBundle(dir, files);
  return dir;
}

const digest = () =>
  GeoTable.parse(gunzipSync(geoBundleFiles().locations)).digest;

beforeEach(() => {
  __setAgentAddressesForTest(async (id) => (PUBLIC[id] ? [PUBLIC[id]] : null));
  process.env.DEPLO_GEO_DIR = geoDir();
  __resetShippedGeoForTest();
  for (const id of MEMBERS)
    hosts[id].capabilities.push(CLUSTER_ZONE_CAPABILITY);
});
afterEach(() => {
  __resetAgentAddressesForTest();
  __resetShippedGeoForTest();
});

async function zoneWithADomain(name: string) {
  const eu = await clusterOf(name, MEMBERS);
  await seedApp(db(), { id: `prj_${name}`, slug: name, serverId: MEMBERS[0] });
  await db()
    .update(appsTable)
    .set({ clusterId: eu.id })
    .where(eq(appsTable.id, `prj_${name}`));
  await db()
    .insert(domainsTable)
    .values({
      id: `dom_${name}`,
      appId: `prj_${name}`,
      name: `shop.${name}.example.com`,
      status: "pending",
      isPrimary: false,
      ssl: true,
      source: "custom",
      answersEverywhere: true,
      createdAt: nowIso(),
    });
  await asAdmin(() => addClusterDnsZone(eu.id, `${name}.example.com`));
  return eu;
}

const placesSent = (id: string) =>
  hosts[id].zoneTables
    .at(-1)!
    .servers.map((s) =>
      s.located ? [s.fingerprint, s.latitude, s.longitude] : [s.fingerprint],
    );

test("the location table goes once, and only to the agents that place visitors with it", async () => {
  hosts.srv_2.capabilities.push(CLUSTER_ZONE_GEO_CAPABILITY);
  hosts.srv_3.capabilities.push(CLUSTER_ZONE_GEO_CAPABILITY);
  const eu = await zoneWithADomain("eu");
  await syncClusterZone(eu.id);
  await syncClusterZone(eu.id);
  for (const id of ["srv_2", "srv_3"])
    assert.deepEqual(
      hosts[id].geoTables.map((g) => g.sha256),
      [digest()],
      `${id} is handed the table once`,
    );
  assert.equal(hosts.srv_4.geoTables.length, 0, "an older agent gets none");
  // srv_4 has no place either, so nobody answers nearest-first until an admin places it.
  let view = await asAdmin(() => clusterDnsView(eu.id));
  assert.deepEqual(
    view.servers.map((s) => [s.serverId, s.nearest]),
    [
      ["srv_2", false],
      ["srv_3", false],
      ["srv_4", false],
    ],
  );
  await asAdmin(() =>
    placeClusterServer("srv_4", { latitude: 35.68, longitude: 139.69 }),
  );
  await syncClusterZone(eu.id);
  view = await asAdmin(() => clusterDnsView(eu.id));
  assert.deepEqual(
    view.servers.map((s) => [s.serverId, s.nearest]),
    [
      ["srv_2", true],
      ["srv_3", true],
      ["srv_4", false],
    ],
  );
  assert.deepEqual(view.geo, {
    state: "ready",
    release: "2026-11",
    stale: geoAgeMonths("2026-11") > 3,
    reusedFrom: null,
    problem: "",
  });
});

test("each server goes to its agent with its place: a city, coordinates, or where its address is", async () => {
  const eu = await zoneWithADomain("place");
  await asAdmin(() =>
    placeClusterServer("srv_3", {
      latitude: 50.11,
      longitude: 8.68,
      label: "Frankfurt am Main, Hesse, Germany",
    }),
  );
  await asAdmin(() =>
    placeClusterServer("srv_4", { latitude: -33.87, longitude: 151.21 }),
  );
  await syncClusterZone(eu.id);
  assert.deepEqual(placesSent("srv_2"), [
    [FP.srv_2, 45, 9],
    [FP.srv_3, 50.11, 8.68],
    [FP.srv_4, -33.87, 151.21],
  ]);
  const view = await asAdmin(() => clusterDnsView(eu.id));
  assert.deepEqual(
    view.places.map((p) => [p.serverId, p.place?.source, p.place?.label]),
    [
      ["srv_2", "address", "45.00, 9.00"],
      ["srv_3", "city", "Frankfurt am Main, Hesse, Germany"],
      ["srv_4", "coordinates", "-33.87, 151.21"],
    ],
  );
  // Back to its address: New York in the fixture's table.
  await asAdmin(() => placeClusterServer("srv_3", null));
  await syncClusterZone(eu.id);
  assert.deepEqual(placesSent("srv_2")[1], [FP.srv_3, 41, -74]);
  // A place off the globe is refused, and only an instance admin places a server.
  await assert.rejects(
    asAdmin(() => placeClusterServer("srv_3", { latitude: 91, longitude: 0 })),
    /latitude/,
  );
  await assert.rejects(
    asMember(() => placeClusterServer("srv_3", { latitude: 1, longitude: 1 })),
  );
});

test("the picker offers the table's cities, to an admin", async () => {
  const hits = await asAdmin(() => findCities("tok"));
  assert.deepEqual(
    hits.map((c) => [c.label, c.latitude, c.longitude]),
    [["Tokyo, Japan", 35.69, 139.69]],
  );
  assert.deepEqual(await asAdmin(() => findCities("nowhere at all")), []);
  await assert.rejects(asMember(() => findCities("tok")));
});

test("with no table, or a damaged one, nothing is handed out and every server is answered", async () => {
  hosts.srv_2.capabilities.push(CLUSTER_ZONE_GEO_CAPABILITY);
  process.env.DEPLO_GEO_DIR = mkdtempSync(join(tmpdir(), "deplo-geo-"));
  __resetShippedGeoForTest();
  const eu = await zoneWithADomain("none");
  await syncClusterZone(eu.id);
  assert.equal(hosts.srv_2.geoTables.length, 0);
  // Nothing places a server by its address; one an admin placed still goes placed.
  assert.deepEqual(placesSent("srv_2"), [[FP.srv_2], [FP.srv_3], [FP.srv_4]]);
  let view = await asAdmin(() => clusterDnsView(eu.id));
  assert.equal(view.geo.state, "missing");

  const damaged = geoBundleFiles();
  damaged.locations[damaged.locations.length - 12] ^= 1;
  process.env.DEPLO_GEO_DIR = geoDir(damaged);
  __resetShippedGeoForTest();
  await syncClusterZone(eu.id);
  assert.equal(hosts.srv_2.geoTables.length, 0);
  view = await asAdmin(() => clusterDnsView(eu.id));
  assert.equal(view.geo.state, "damaged");
  assert.ok(view.geo.problem.length > 0);
});

test("a table is old once it is more than three months behind", () => {
  const now = new Date("2026-11-20T00:00:00Z");
  assert.equal(geoAgeMonths("2026-11", now), 0);
  assert.equal(geoAgeMonths("2026-08", now), 3);
  assert.equal(geoAgeMonths("2026-07", now), 4);
  assert.equal(geoAgeMonths("2025-12", now), 11);
});
