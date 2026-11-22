import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SetClusterZoneRequest } from "../agent/gen/agent";
import {
  chooseNameServers,
  cleanZoneName,
  delegationRecords,
  dnsTimesRefusal,
  placeRefusal,
  renderClusterZone,
  zoneTarget,
} from "./cluster-zone";
import {
  domainModes,
  zoneCertificatesFor,
  zoneChallenges,
  type ZoneCertDomain,
} from "./zone-certs";

// ADR-0049: what Deplo renders for a cluster's DNS zone, and the name servers it picks.

test("a zone name is made canonical, and what is not one is refused in the person's words", () => {
  assert.deepEqual(cleanZoneName(" Go.Example.COM. "), {
    name: "go.example.com",
  });
  assert.deepEqual(cleanZoneName("https://go.example.com/x"), {
    name: "go.example.com",
  });
  for (const bad of [
    "",
    "localhost",
    "go example.com",
    "-go.example.com",
    "go.example.123",
    "a..b.com",
    `${"a".repeat(64)}.com`,
  ])
    assert.match(cleanZoneName(bad).error ?? "", /is not a domain/, bad);
});

test("a domain in the zone answers as itself; one outside gets a name of its own in the zone", () => {
  assert.equal(
    zoneTarget("shop.go.example.com", "go.example.com"),
    "shop.go.example.com",
  );
  assert.equal(
    zoneTarget("go.example.com", "go.example.com"),
    "go.example.com",
  );
  assert.equal(
    zoneTarget("shop.example.com", "go.example.com"),
    "shop-example-com.go.example.com",
  );
  assert.notEqual(
    zoneTarget("a.example.com", "go.example.com"),
    zoneTarget("b.example.com", "go.example.com"),
  );
  // Past 63 characters the label is cut and tagged, so it stays one valid, distinct label.
  const long = `${"x".repeat(60)}.example.com`;
  const t = zoneTarget(long, "go.example.com");
  const label = t.split(".")[0];
  assert.ok(label.length <= 63, t);
  assert.match(label, /^[a-z0-9-]+-[0-9a-f]{8}$/);
  assert.notEqual(
    t,
    zoneTarget(`${"x".repeat(60)}.example.org`, "go.example.com"),
  );
});

const cand = (
  serverId: string,
  joinedAt: string,
  eligible = true,
  member = true,
) => ({ serverId, joinedAt, eligible, member });

test("name servers: the longest-joined servers that can answer, at most four", () => {
  const picked = chooseNameServers(
    [],
    [
      cand("s5", "2026-01-05"),
      cand("s1", "2026-01-01"),
      cand("s3", "2026-01-03", false),
      cand("s2", "2026-01-02"),
      cand("s4", "2026-01-04"),
      cand("s6", "2026-01-06"),
    ],
  );
  assert.deepEqual(picked, [
    { position: 1, serverId: "s1" },
    { position: 2, serverId: "s2" },
    { position: 3, serverId: "s4" },
    { position: 4, serverId: "s5" },
  ]);
});

test("name servers stay where they are, and only a leaving one is replaced", () => {
  const current = [
    { position: 1, serverId: "s2" },
    { position: 2, serverId: "s1" },
  ];
  const all = [
    cand("s1", "2026-01-01"),
    cand("s2", "2026-01-02"),
    cand("s3", "2026-01-03"),
  ];
  // A server that joined earlier does not push a chosen one out: the registrar's records stay right.
  assert.deepEqual(chooseNameServers(current, all), [
    ...current,
    { position: 3, serverId: "s3" },
  ]);
  // s2 leaves the cluster: s3 takes its place, ns2 stays s1.
  assert.deepEqual(
    chooseNameServers(current, [
      cand("s1", "2026-01-01"),
      cand("s3", "2026-01-03"),
    ]),
    [
      { position: 1, serverId: "s3" },
      { position: 2, serverId: "s1" },
    ],
  );
  // s1 says it cannot answer on port 53 and nobody can take its place: the names close up.
  assert.deepEqual(
    chooseNameServers(current, [
      cand("s1", "2026-01-01", false),
      cand("s2", "2026-01-02"),
    ]),
    [{ position: 1, serverId: "s2" }],
  );
});

const GOLDEN = join(process.cwd(), "lib", "deploy", "cluster-zone.golden.json");
const FP = (d: string) => d.repeat(64);

const goldenDomains: ZoneCertDomain[] = [
  {
    id: "d1",
    name: "go.example.com",
    zoneId: "z1",
    zone: "go.example.com",
    inside: true,
    cnameSeen: false,
    serverId: "srv1",
  },
  {
    id: "d2",
    name: "shop.example.com",
    zoneId: "z1",
    zone: "go.example.com",
    inside: false,
    cnameSeen: true,
    serverId: "srv2",
  },
];
const GOLDEN_CERTS = {
  zones: [
    {
      id: "z1",
      name: "go.example.com",
      renewerServerId: "srv1",
      sha256: "ab".repeat(32),
      notAfter: "2999-01-01T00:00:00.000Z",
      pair: null,
    },
  ],
  domains: goldenDomains,
  modes: domainModes(goldenDomains, { wildcard: true, eligible: true }),
  fingerprintOf: (id: string) => ({ srv1: FP("1"), srv2: FP("2") })[id] ?? null,
};

function goldenRequest() {
  return renderClusterZone({
    clusterId: "cl_golden",
    self: FP("1"),
    zones: [
      {
        name: "go.example.com",
        names: [
          "shop-example-com.go.example.com",
          "go.example.com",
          "go.example.com",
        ],
        homes: [
          { name: "shop-example-com.go.example.com", fingerprint: FP("2") },
          { name: "elsewhere.example.com", fingerprint: FP("1") },
        ],
      },
    ],
    servers: [
      {
        fingerprint: FP("1"),
        v4: ["203.0.113.10"],
        v6: ["2001:db8::10"],
        emptying: false,
        place: { lat: 45.4642, lon: 9.1896 },
      },
      {
        fingerprint: FP("2"),
        v4: ["203.0.113.11"],
        v6: [],
        emptying: false,
        place: { lat: 40.71, lon: -74.01 },
      },
      { fingerprint: FP("3"), v4: ["203.0.113.12"], v6: [], emptying: true },
    ],
    nameServers: [FP("1"), FP("2")],
    ttl: 30,
    dropAfter: 10,
    challenges: zoneChallenges(GOLDEN_CERTS),
    certificates: zoneCertificatesFor({
      ...GOLDEN_CERTS,
      serverId: "srv1",
      reported: () => "ab".repeat(32),
      now: 0,
    }),
  });
}

// The agent reads the same file (deplo-agent internal/server/testdata) and must accept it: a contract across the repos.
test("the request matches the reference the agent checks", () => {
  const json = SetClusterZoneRequest.toJSON(goldenRequest());
  if (process.env.UPDATE_GOLDEN === "1")
    writeFileSync(GOLDEN, `${JSON.stringify(json, null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(GOLDEN, "utf8")), json);
});

test("the records to add at the registrar: NS, then each name server's addresses", () => {
  assert.deepEqual(
    delegationRecords("go.example.com", [
      { v4: ["203.0.113.10"], v6: ["2001:db8::10"] },
      { v4: ["203.0.113.11"], v6: [] },
    ]),
    [
      { name: "go.example.com", type: "NS", value: "ns1.go.example.com" },
      { name: "go.example.com", type: "NS", value: "ns2.go.example.com" },
      { name: "ns1.go.example.com", type: "A", value: "203.0.113.10" },
      { name: "ns1.go.example.com", type: "AAAA", value: "2001:db8::10" },
      { name: "ns2.go.example.com", type: "A", value: "203.0.113.11" },
    ],
  );
});

test("a server's place goes to the agent to hundredths of a degree, and none says it has none", () => {
  const req = goldenRequest();
  assert.deepEqual(
    req.servers.map((s) => [s.located, s.latitude, s.longitude]),
    [
      [true, 45.46, 9.19],
      [true, 40.71, -74.01],
      [false, 0, 0],
    ],
  );
});

test("coordinates typed for a server must be on the globe", () => {
  assert.equal(placeRefusal(45.46, 9.19), null);
  assert.equal(placeRefusal(-90, 180), null);
  assert.match(placeRefusal(90.1, 0)!, /latitude/);
  assert.match(placeRefusal(0, -180.5)!, /longitude/);
  assert.match(placeRefusal(Number.NaN, 0)!, /latitude/);
});

test("the two times keep to the agent's ranges", () => {
  assert.equal(dnsTimesRefusal(30, 10), null);
  assert.equal(dnsTimesRefusal(10, 5), null);
  assert.equal(dnsTimesRefusal(300, 60), null);
  assert.match(dnsTimesRefusal(9, 10)!, /10 to 300/);
  assert.match(dnsTimesRefusal(301, 10)!, /10 to 300/);
  assert.match(dnsTimesRefusal(30, 4)!, /5 to 60/);
  assert.match(dnsTimesRefusal(30, 61)!, /5 to 60/);
  assert.match(dnsTimesRefusal(30.5, 10)!, /10 to 300/);
});
