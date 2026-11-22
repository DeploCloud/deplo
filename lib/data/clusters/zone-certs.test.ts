import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";

import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";

import { activities } from "../../db/schema/control-plane/activity";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterNameCerts,
  clusterZoneCerts,
} from "../../db/schema/control-plane/clusters";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { hasDnsChallenge } from "../../deploy/traefik-cluster";
import { nowIso } from "../../ids";
import {
  CLUSTER_ZONE_CAPABILITY,
  DNS_CERTIFICATES_CAPABILITY,
  DNS_CHALLENGE_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";
import { seedApp } from "../app-graph-test-helpers";
import {
  MEMBERS,
  FP,
  asAdmin,
  clusterOf,
  db,
  dissolveHarness,
  hosts,
} from "../cluster-dissolve-test-helpers";
import { routableRoutes } from "../domains/routes";
import { proxyRestartMessage } from "./answer-certs";
import { clusterDnsView, syncClusterZone } from "./dns-zone";
import { addClusterDnsZone, removeClusterDnsZone } from "./zone-settings";
import { domainZoneTargets, setDomainDnsZone } from "./zone-domains";
import { __setCnameLookupForTest } from "./zone-cnames";
import { __forgetZoneCerts, setClusterDnsWildcard } from "./zone-certs";
import {
  __resetAgentAddressesForTest,
  __setAgentAddressesForTest,
} from "../servers/addresses";

// ADR-0049 phase 3: certificates checked over DNS from the cluster's own zone, one per zone, renewed by one server.
dissolveHarness();

const PROXY = `services:
  traefik:
    image: traefik:v3.7.17
    container_name: deplo-traefik
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
      - --certificatesresolvers.letsencrypt.acme.email=admin@acme.com
      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json
`;

beforeEach(() => {
  __forgetZoneCerts();
  __setAgentAddressesForTest(async (id) => [`203.0.113.${id.slice(-1)}`]);
  __setCnameLookupForTest(async () => {
    throw Object.assign(new Error("no"), { code: "ENODATA" });
  });
  for (const id of MEMBERS) {
    hosts[id].capabilities.push(
      CLUSTER_ZONE_CAPABILITY,
      DNS_CHALLENGE_CAPABILITY,
    );
    hosts[id].proxy.yaml = PROXY;
  }
});
afterEach(() => {
  __resetAgentAddressesForTest();
  __setCnameLookupForTest(null);
});

const RENEWER = MEMBERS[0];
const lastTable = (id: string) => hosts[id].zoneTables.at(-1)!;

async function domain(clusterId: string, id: string, name: string) {
  const [app] = await db()
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "prj_web"));
  if (!app) {
    await seedApp(db(), { id: "prj_web", slug: "web", serverId: MEMBERS[1] });
    await db()
      .update(appsTable)
      .set({ clusterId })
      .where(eq(appsTable.id, "prj_web"));
  }
  await db().insert(domainsTable).values({
    id,
    appId: "prj_web",
    name,
    status: "valid",
    isPrimary: false,
    ssl: true,
    source: "custom",
    answersEverywhere: true,
    createdAt: nowIso(),
  });
}

async function zoneCluster(...names: [string, string][]) {
  const eu = await clusterOf("eu", MEMBERS);
  for (const [id, name] of names) await domain(eu.id, id, name);
  const zoneId = await asAdmin(() =>
    addClusterDnsZone(eu.id, "go.example.com"),
  );
  return { eu, zoneId };
}

const modeOf = async (id: string) =>
  (
    await db()
      .select({ m: domainsTable.certChallenge })
      .from(domainsTable)
      .where(eq(domainsTable.id, id))
  )[0]?.m ?? null;

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

/** A pair for the zone and every name below it, valid for `days`. */
const zonePair = (days: number) =>
  pairFor(["go.example.com", "*.go.example.com"], days);

/** A pair for these names, valid for `days`. */
async function pairFor(names: string[], days: number) {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  // x509 types against the DOM CryptoKey; node's webcrypto is structurally its own.
  const keys = (await webcrypto.subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${names[0]}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + days * 86_400_000),
    keys,
    signingAlgorithm: alg,
    extensions: [
      new x509.SubjectAlternativeNameExtension(
        names.map((value) => ({ type: "dns" as const, value })),
      ),
    ],
  });
  const der = Buffer.from(
    await webcrypto.subtle.exportKey(
      "pkcs8",
      keys.privateKey as unknown as webcrypto.CryptoKey,
    ),
  );
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END PRIVATE KEY-----\n`;
  return {
    certPem: cert.toString("pem"),
    keyPem,
    sha256: createHash("sha256")
      .update(Buffer.from(cert.rawData))
      .digest("hex"),
    notAfterUnixMs: cert.notAfter.getTime(),
  };
}

/** The renewer's agent reports this pair from now on, as its proxy just got it. */
function renewerHolds(
  serverId: string,
  pair: Awaited<ReturnType<typeof zonePair>>,
) {
  const base = hosts[serverId].zoneReport;
  hosts[serverId].zoneReport = (table) => ({
    ...base(table),
    certificates: table.certificates.map((c) => ({
      zone: c.zone,
      names: c.names ?? [],
      sha256: pair.sha256,
      notAfterUnixMs: pair.notAfterUnixMs,
      certPem: c.sha256 === pair.sha256 ? "" : pair.certPem,
      keyPem: c.sha256 === pair.sha256 ? "" : pair.keyPem,
      error: "",
      errorAtUnixMs: 0,
      ordering: false,
    })),
  });
}

test("each server's proxy gets the resolver that checks over DNS once, and loses it with the zone", async () => {
  const { eu, zoneId } = await zoneCluster(["d1", "shop.go.example.com"]);
  await syncClusterZone(eu.id);
  for (const id of MEMBERS) {
    assert.equal(hasDnsChallenge(hosts[id].proxy.yaml), true, id);
    assert.equal(hosts[id].proxy.applied, 1, id);
  }
  await syncClusterZone(eu.id);
  for (const id of MEMBERS) assert.equal(hosts[id].proxy.applied, 1, id);
  await asAdmin(() => removeClusterDnsZone(zoneId));
  await syncClusterZone(eu.id);
  for (const id of MEMBERS) {
    assert.equal(hasDnsChallenge(hosts[id].proxy.yaml), false, id);
    assert.equal(hosts[id].proxy.applied, 2, id);
  }
});

test("while one server cannot check over DNS, every name keeps HTTP-01", async () => {
  hosts[MEMBERS[2]].capabilities = hosts[MEMBERS[2]].capabilities.filter(
    (c) => c !== DNS_CHALLENGE_CAPABILITY,
  );
  const { eu } = await zoneCluster(["d1", "shop.go.example.com"]);
  await syncClusterZone(eu.id);
  for (const id of MEMBERS) {
    assert.deepEqual(lastTable(id).challenges, []);
    assert.deepEqual(lastTable(id).certificates, []);
  }
  assert.equal(hasDnsChallenge(hosts[MEMBERS[2]].proxy.yaml), false);
  assert.equal(await modeOf("d1"), null);
});

test("an empty zone orders nothing; one with several domains gets one certificate, ordered by one server", async () => {
  const { eu } = await zoneCluster();
  await syncClusterZone(eu.id);
  for (const id of MEMBERS) {
    assert.deepEqual(lastTable(id).certificates, []);
    assert.deepEqual(lastTable(id).challenges, []);
  }
  await domain(eu.id, "d1", "shop.go.example.com");
  await domain(eu.id, "d2", "blog.go.example.com");
  await domain(eu.id, "d3", "go.example.com");
  await syncClusterZone(eu.id);
  const ordering = MEMBERS.filter((id) => {
    const certs = lastTable(id).certificates;
    assert.equal(certs.length, 1, id);
    return certs[0].order;
  });
  assert.deepEqual(ordering, [RENEWER]);
  assert.deepEqual(lastTable(MEMBERS[1]).challenges, [
    {
      asked: "_acme-challenge.go.example.com",
      at: "_acme-challenge.go.example.com",
      ownerFingerprint: FP[RENEWER],
    },
  ]);
  // The renewer is handed the zone after everyone else.
  assert.ok(
    hosts[RENEWER].zoneTables.length > 0 &&
      MEMBERS.slice(1).every((id) => hosts[id].zoneTables.length > 0),
  );
  for (const id of ["d1", "d2", "d3"]) assert.equal(await modeOf(id), "zone");
  // Its routes ask the proxy for no certificate of their own.
  const routes = await routableRoutes("prj_web");
  assert.ok(routes.length >= 3);
  for (const r of routes) assert.equal(r.certResolver, "", r.name);
});

test("the renewer's new pair is kept sealed and reaches every other server in the same pass, its key once", async () => {
  const { eu, zoneId } = await zoneCluster(["d1", "shop.go.example.com"]);
  await syncClusterZone(eu.id);
  const pair = await zonePair(90);
  renewerHolds(RENEWER, pair);
  await syncClusterZone(eu.id);
  const [row] = await db()
    .select()
    .from(clusterZoneCerts)
    .where(eq(clusterZoneCerts.zoneId, zoneId));
  assert.equal(row.sha256, pair.sha256);
  assert.ok(row.keyEnc && !row.keyEnc.includes("PRIVATE KEY"));
  assert.ok(row.issuedAt);
  for (const id of MEMBERS.slice(1)) {
    const [c] = lastTable(id).certificates;
    assert.equal(c.keyPem, pair.keyPem, id);
    assert.deepEqual(c.covered, ["shop.go.example.com"]);
  }
  // Once a server says it holds it, the key stays home.
  for (const id of MEMBERS.slice(1)) renewerHolds(id, pair);
  await syncClusterZone(eu.id);
  await syncClusterZone(eu.id);
  for (const id of MEMBERS)
    assert.equal(lastTable(id).certificates[0].keyPem, "", id);
  const said = await db().select().from(activities);
  assert.ok(said.some((a) => /got its certificate/.test(a.message)));
  assert.ok(!said.some((a) => a.message.includes("PRIVATE KEY")));
  const view = await asAdmin(() => clusterDnsView(eu.id));
  assert.equal(view.zones[0].certificate.renewer?.serverId, RENEWER);
  assert.deepEqual(view.zones[0].certificate.serves, ["shop.go.example.com"]);
  assert.ok(view.zones[0].certificate.validUntil);
  assert.ok(!JSON.stringify(view).includes("PRIVATE KEY"));
});

test("a pair from a server that does not renew the zone is never taken", async () => {
  const { eu, zoneId } = await zoneCluster(["d1", "shop.go.example.com"]);
  await syncClusterZone(eu.id);
  const pair = await zonePair(90);
  renewerHolds(RENEWER, pair);
  await syncClusterZone(eu.id);
  renewerHolds(MEMBERS[2], await zonePair(120));
  await syncClusterZone(eu.id);
  const [row] = await db()
    .select()
    .from(clusterZoneCerts)
    .where(eq(clusterZoneCerts.zoneId, zoneId));
  assert.equal(row.sha256, pair.sha256);
  assert.equal(lastTable(MEMBERS[1]).certificates[0].sha256, pair.sha256);
});

test("the renewer stops: another server takes over after ten minutes, with the pair, and orders nothing new", async () => {
  const { eu, zoneId } = await zoneCluster(["d1", "shop.go.example.com"]);
  await syncClusterZone(eu.id);
  const pair = await zonePair(90);
  renewerHolds(RENEWER, pair);
  await syncClusterZone(eu.id);
  hosts[RENEWER].unreachable = true;
  await syncClusterZone(eu.id);
  await syncClusterZone(eu.id);
  let [row] = await db()
    .select()
    .from(clusterZoneCerts)
    .where(eq(clusterZoneCerts.zoneId, zoneId));
  assert.equal(row.renewerServerId, RENEWER);
  assert.ok(row.renewerLostAt);
  await db()
    .update(clusterZoneCerts)
    .set({ renewerLostAt: new Date(Date.now() - 11 * 60_000).toISOString() })
    .where(eq(clusterZoneCerts.zoneId, zoneId));
  await syncClusterZone(eu.id);
  [row] = await db()
    .select()
    .from(clusterZoneCerts)
    .where(eq(clusterZoneCerts.zoneId, zoneId));
  const next = MEMBERS[1];
  assert.equal(row.renewerServerId, next);
  assert.equal(row.sha256, pair.sha256);
  const [c] = lastTable(next).certificates;
  assert.equal(c.renew, true);
  assert.equal(c.sha256, pair.sha256);
  assert.equal(c.keyPem, pair.keyPem);
  assert.deepEqual(lastTable(next).challenges[0].ownerFingerprint, FP[next]);
  assert.equal(lastTable(MEMBERS[2]).certificates[0].renew, false);
});

test("the switch off: each name gets its own certificate over DNS, set by its App's server", async () => {
  const { eu } = await zoneCluster(
    ["d1", "shop.go.example.com"],
    ["d2", "blog.go.example.com"],
  );
  await syncClusterZone(eu.id);
  await asAdmin(() => setClusterDnsWildcard(eu.id, false));
  await syncClusterZone(eu.id);
  for (const id of MEMBERS) assert.deepEqual(lastTable(id).certificates, []);
  assert.deepEqual(
    lastTable(MEMBERS[0]).challenges.map((c) => [c.asked, c.ownerFingerprint]),
    [
      ["_acme-challenge.blog.go.example.com", FP[MEMBERS[1]]],
      ["_acme-challenge.shop.go.example.com", FP[MEMBERS[1]]],
    ],
  );
  assert.equal(await modeOf("d1"), "dns");
  for (const r of await routableRoutes("prj_web"))
    assert.equal(r.certResolver, "deplo-dns", r.name);
});

test("a name outside the zone keeps HTTP-01 without its CNAME, and checks over DNS once it is seen", async () => {
  const { eu, zoneId } = await zoneCluster(["d1", "shop.example.com"]);
  await asAdmin(() => setDomainDnsZone("d1", zoneId));
  await syncClusterZone(eu.id);
  assert.equal(await modeOf("d1"), null);
  assert.deepEqual(lastTable(MEMBERS[0]).challenges, []);
  for (const r of await routableRoutes("prj_web"))
    assert.equal(r.certResolver, "letsencrypt", r.name);
  __setCnameLookupForTest(async (name) =>
    name === "_acme-challenge.shop.example.com"
      ? ["_acme-challenge.shop-example-com.go.example.com"]
      : [],
  );
  await syncClusterZone(eu.id);
  assert.equal(await modeOf("d1"), "dns");
  assert.deepEqual(lastTable(MEMBERS[0]).challenges, [
    {
      asked: "_acme-challenge.shop.example.com",
      at: "_acme-challenge.shop-example-com.go.example.com",
      ownerFingerprint: FP[MEMBERS[1]],
    },
  ]);
  const t = (await asAdmin(() => domainZoneTargets("prj_web"))).get("d1");
  assert.equal(t?.cert.check?.seen, true);
});

test("a zone certificate handed to another server is said as such", () => {
  assert.match(
    proxyRestartMessage("eu-1", {
      atUnixMs: Date.parse("2026-11-20T03:00:00Z"),
      hosts: ["go.example.com", "*.go.example.com"],
      urgent: false,
      dropped: true,
      zone: true,
    }),
    /restarted the proxy on eu-1 2026-11-20 at 03:00 UTC so another server renews the certificate of go\.example\.com, \*\.go\.example\.com; eu-1 keeps serving it/,
  );
  assert.match(
    proxyRestartMessage("eu-1", {
      atUnixMs: Date.parse("2026-11-20T03:00:00Z"),
      hosts: ["shop.go.example.com"],
      urgent: false,
      dropped: true,
      zone: true,
    }),
    /to remove the certificate of shop\.go\.example\.com, which its DNS zone's certificate serves now/,
  );
});

// ADR-0048 step 5 (#228): with every agent able to hold it, a name's own certificate follows the zone's model.
const shareable = () => {
  for (const id of MEMBERS)
    hosts[id].capabilities.push(DNS_CERTIFICATES_CAPABILITY);
};
const nameCert = (id: string) =>
  lastTable(id).certificates.find((c) => c.names[0] === "shop.example.com");

/** A server's agent reports this pair as the name's own certificate it holds. */
function holdsName(
  serverId: string,
  pair: Awaited<ReturnType<typeof pairFor>>,
) {
  const base = hosts[serverId].zoneReport;
  hosts[serverId].zoneReport = (table) => ({
    ...base(table),
    certificates: table.certificates
      .filter((c) => c.names.length > 0)
      .map((c) => ({
        zone: c.zone,
        names: c.names,
        sha256: pair.sha256,
        notAfterUnixMs: pair.notAfterUnixMs,
        certPem: c.sha256 === pair.sha256 ? "" : pair.certPem,
        keyPem: c.sha256 === pair.sha256 ? "" : pair.keyPem,
        error: "",
        errorAtUnixMs: 0,
        ordering: false,
      })),
  });
}

async function sharedName() {
  shareable();
  const { eu, zoneId } = await zoneCluster(["d1", "shop.example.com"]);
  await asAdmin(() => setDomainDnsZone("d1", zoneId));
  __setCnameLookupForTest(async (name) =>
    name === "_acme-challenge.shop.example.com"
      ? ["_acme-challenge.shop-example-com.go.example.com"]
      : [],
  );
  await syncClusterZone(eu.id);
  return { eu, zoneId };
}

const nameRow = async (zoneId: string) =>
  (
    await db()
      .select()
      .from(clusterNameCerts)
      .where(eq(clusterNameCerts.zoneId, zoneId))
  )[0];

test("a name's own certificate is renewed by its App's server and held by every other, routed with no resolver", async () => {
  const { eu, zoneId } = await sharedName();
  const app = MEMBERS[1];
  assert.equal(await modeOf("d1"), "shared");
  for (const r of await routableRoutes("prj_web"))
    assert.equal(r.certResolver, "", r.name);
  // The App's server ordered it over DNS until now: it stays the renewer, so nothing is ordered twice.
  assert.equal((await nameRow(zoneId)).renewerServerId, app);
  assert.equal(
    lastTable(MEMBERS[0]).challenges.find(
      (c) => c.asked === "_acme-challenge.shop.example.com",
    )?.ownerFingerprint,
    FP[app],
  );
  assert.deepEqual(
    MEMBERS.map((id) => [nameCert(id)?.zone, nameCert(id)?.renew]),
    MEMBERS.map((id) => ["go.example.com", id === app]),
  );

  const pair = await pairFor(["shop.example.com"], 90);
  holdsName(app, pair);
  holdsName(MEMBERS[2], await pairFor(["shop.example.com"], 120));
  await syncClusterZone(eu.id);
  const row = await nameRow(zoneId);
  assert.equal(
    row.sha256,
    pair.sha256,
    "a pair from a server that does not renew it is never taken",
  );
  assert.ok(row.keyEnc && !row.keyEnc.includes("PRIVATE KEY"));
  for (const id of [MEMBERS[0], MEMBERS[2]]) {
    assert.equal(nameCert(id)?.sha256, pair.sha256, id);
    assert.equal(nameCert(id)?.keyPem, pair.keyPem, id);
  }
  const said = await db().select().from(activities);
  assert.ok(
    said.some((a) =>
      /now holds the certificate of shop\.example\.com/.test(a.message),
    ),
  );
});

test("the renewer of a name's certificate stops: another server takes it over after ten minutes, with the pair", async () => {
  const { eu, zoneId } = await sharedName();
  const pair = await pairFor(["shop.example.com"], 90);
  holdsName(MEMBERS[1], pair);
  await syncClusterZone(eu.id);
  hosts[MEMBERS[1]].unreachable = true;
  await syncClusterZone(eu.id);
  assert.equal((await nameRow(zoneId)).renewerServerId, MEMBERS[1]);
  await db()
    .update(clusterNameCerts)
    .set({ renewerLostAt: new Date(Date.now() - 11 * 60_000).toISOString() })
    .where(eq(clusterNameCerts.zoneId, zoneId));
  await syncClusterZone(eu.id);
  const next = MEMBERS[0];
  assert.equal((await nameRow(zoneId)).renewerServerId, next);
  assert.equal(nameCert(next)?.renew, true);
  assert.equal(nameCert(next)?.sha256, pair.sha256);
  assert.equal(
    lastTable(next).challenges.find(
      (c) => c.asked === "_acme-challenge.shop.example.com",
    )?.ownerFingerprint,
    FP[next],
  );
  assert.equal(nameCert(MEMBERS[2])?.renew, false);
});

test("while one server's agent cannot hold it, a name keeps its own certificate on its App's server", async () => {
  const { eu } = await sharedName();
  hosts[MEMBERS[2]].capabilities = hosts[MEMBERS[2]].capabilities.filter(
    (c) => c !== DNS_CERTIFICATES_CAPABILITY,
  );
  await syncClusterZone(eu.id);
  assert.equal(await modeOf("d1"), "dns");
  for (const id of MEMBERS) assert.equal(nameCert(id), undefined, id);
});

test("a server that lost a name's certificate is handed it again on the next pass", async () => {
  const { eu } = await sharedName();
  const pair = await pairFor(["shop.example.com"], 90);
  holdsName(MEMBERS[1], pair);
  await syncClusterZone(eu.id);
  const other = MEMBERS[2];
  const base = hosts[other].zoneReport;
  holdsName(other, pair);
  await syncClusterZone(eu.id);
  await syncClusterZone(eu.id);
  assert.equal(
    nameCert(other)?.keyPem,
    "",
    "a server that holds it is not sent the key again",
  );
  // Its proxy no longer serves it: it says so, and the next pass sends the pair back.
  hosts[other].zoneReport = base;
  await syncClusterZone(eu.id);
  await syncClusterZone(eu.id);
  assert.equal(nameCert(other)?.sha256, pair.sha256);
  assert.equal(nameCert(other)?.keyPem, pair.keyPem);
});
