import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RENEWER_LOST_AFTER_MS,
  chooseRenewer,
  clusterCanCheckOverDns,
  domainModes,
  renewersLast,
  zoneCertErrorWords,
  zoneCertificatesFor,
  zoneChallenges,
  type ZoneCertDomain,
  type ZoneCertMember,
  type ZonePlanZone,
} from "./zone-certs";

// ADR-0049 phase 3: which names a zone's certificate serves, who renews it, and the checks answered from the zone.

const NOW = Date.parse("2026-11-20T12:00:00Z");
const member = (
  serverId: string,
  joinedAt: string,
  over: Partial<ZoneCertMember> = {},
): ZoneCertMember => ({
  serverId,
  fingerprint: `fp-${serverId}`,
  joinedAt,
  emptying: false,
  capable: true,
  reachable: true,
  shares: false,
  ...over,
});
const domain = (
  id: string,
  name: string,
  over: Partial<ZoneCertDomain> = {},
): ZoneCertDomain => ({
  id,
  name,
  zoneId: "z1",
  zone: "lab.test",
  inside: true,
  cnameSeen: false,
  serverId: "s1",
  ...over,
});
const zone = (over: Partial<ZonePlanZone> = {}): ZonePlanZone => ({
  id: "z1",
  name: "lab.test",
  renewerServerId: "s1",
  sha256: null,
  notAfter: null,
  pair: null,
  ...over,
});
const fp = (id: string) => `fp-${id}`;

function plan(
  domains: ZoneCertDomain[],
  zones: ZonePlanZone[],
  opts = { wildcard: true, eligible: true },
) {
  const modes = domainModes(domains, opts);
  return {
    modes,
    challenges: zoneChallenges({ zones, domains, modes, fingerprintOf: fp }),
    certs: (serverId: string, reported?: string) =>
      zoneCertificatesFor({
        serverId,
        zones,
        domains,
        modes,
        reported: () => reported,
        now: NOW,
      }),
  };
}

test("a zone with several domains gets one certificate, ordered by one server; an empty zone gets none", () => {
  const p = plan(
    [
      domain("a", "shop.lab.test"),
      domain("b", "blog.lab.test"),
      domain("c", "lab.test"),
    ],
    [zone()],
  );
  assert.deepEqual([...p.modes.values()], ["zone", "zone", "zone"]);
  assert.deepEqual(p.challenges, [
    {
      asked: "_acme-challenge.lab.test",
      at: "_acme-challenge.lab.test",
      ownerFingerprint: "fp-s1",
    },
  ]);
  const ordering = ["s1", "s2", "s3"].filter((s) => p.certs(s)[0]?.order);
  assert.deepEqual(ordering, ["s1"]);
  assert.equal(p.certs("s2").length, 1);
  assert.equal(p.certs("s2")[0].renew, false);

  const empty = plan([], [zone()]);
  assert.deepEqual(empty.challenges, []);
  assert.deepEqual(empty.certs("s1"), []);
});

test("a name two labels below the zone is not served by it and gets its own over DNS", () => {
  const p = plan([domain("a", "a.b.lab.test", { serverId: "s2" })], [zone()]);
  assert.equal(p.modes.get("a"), "dns");
  assert.deepEqual(p.challenges, [
    {
      asked: "_acme-challenge.a.b.lab.test",
      at: "_acme-challenge.a.b.lab.test",
      ownerFingerprint: "fp-s2",
    },
  ]);
  assert.deepEqual(p.certs("s1"), []);
});

test("the switch off: every name gets its own certificate over DNS, set by its App's server", () => {
  const p = plan(
    [
      domain("a", "shop.lab.test", { serverId: "s1" }),
      domain("b", "blog.lab.test", { serverId: "s2" }),
    ],
    [zone()],
    { wildcard: false, eligible: true },
  );
  assert.deepEqual([...p.modes.values()], ["dns", "dns"]);
  assert.deepEqual(
    p.challenges.map((c) => [c.asked, c.ownerFingerprint]),
    [
      ["_acme-challenge.blog.lab.test", "fp-s2"],
      ["_acme-challenge.shop.lab.test", "fp-s1"],
    ],
  );
  assert.deepEqual(p.certs("s1"), []);
});

test("a name outside the zone keeps HTTP-01 until its CNAME is seen, then is checked where it points", () => {
  const out = domain("a", "shop.example.com", {
    inside: false,
    serverId: "s2",
  });
  assert.equal(plan([out], [zone()]).modes.get("a"), "http");
  assert.deepEqual(plan([out], [zone()]).challenges, []);
  const seen = plan([{ ...out, cnameSeen: true }], [zone()]);
  assert.equal(seen.modes.get("a"), "dns");
  assert.deepEqual(seen.challenges, [
    {
      asked: "_acme-challenge.shop.example.com",
      at: "_acme-challenge.shop-example-com.lab.test",
      ownerFingerprint: "fp-s2",
    },
  ]);
});

test("servers that cannot check over DNS yet keep every name on HTTP-01", () => {
  const p = plan([domain("a", "shop.lab.test")], [zone()], {
    wildcard: true,
    eligible: false,
  });
  assert.equal(p.modes.get("a"), "http");
  assert.deepEqual(p.challenges, []);
  assert.equal(
    clusterCanCheckOverDns([
      member("s1", "1"),
      member("s2", "2", { capable: false }),
    ]),
    false,
  );
  // One Deplo cannot reach does not hold the rest back.
  assert.equal(
    clusterCanCheckOverDns([
      member("s1", "1"),
      member("s2", "2", { capable: false, reachable: false }),
    ]),
    true,
  );
});

test("the renewer stays while it answers, and another takes over once it has been away long enough", () => {
  const members = [
    member("s1", "2026-01-01"),
    member("s2", "2026-01-02"),
    member("s3", "2026-01-03"),
  ];
  assert.deepEqual(chooseRenewer(null, members, NOW), {
    serverId: "s1",
    lostAt: null,
  });
  const away = members.map((m) =>
    m.serverId === "s1" ? { ...m, reachable: false } : m,
  );
  const first = chooseRenewer(
    { renewerServerId: "s1", renewerLostAt: null },
    away,
    NOW,
  );
  assert.equal(first.serverId, "s1");
  assert.ok(first.lostAt);
  const later = chooseRenewer(
    first.serverId
      ? { renewerServerId: "s1", renewerLostAt: first.lostAt }
      : null,
    away,
    NOW + RENEWER_LOST_AFTER_MS,
  );
  assert.deepEqual(later, { serverId: "s2", lostAt: null });
  // Back before the wait is over: it keeps it.
  assert.deepEqual(
    chooseRenewer(
      { renewerServerId: "s1", renewerLostAt: first.lostAt },
      members,
      NOW + 60_000,
    ),
    { serverId: "s1", lostAt: null },
  );
  // A server that left, or is being emptied, is replaced at once.
  assert.equal(
    chooseRenewer(
      { renewerServerId: "gone", renewerLostAt: null },
      members,
      NOW,
    ).serverId,
    "s1",
  );
  const emptying = members.map((m) =>
    m.serverId === "s1" ? { ...m, emptying: true } : m,
  );
  assert.equal(
    chooseRenewer({ renewerServerId: "s1", renewerLostAt: null }, emptying, NOW)
      .serverId,
    "s2",
  );
});

test("the server taking over gets the valid pair Deplo holds, so it orders nothing new", () => {
  const valid = zone({
    renewerServerId: "s2",
    sha256: "ab".repeat(32),
    notAfter: new Date(NOW + 86_400_000).toISOString(),
    pair: { certPem: "CERT", keyPem: "KEY" },
  });
  const p = plan([domain("a", "shop.lab.test")], [valid]);
  const [c] = p.certs("s2", undefined);
  assert.equal(c.renew, true);
  assert.equal(c.sha256, "ab".repeat(32));
  assert.equal(c.certPem, "CERT");
  assert.equal(c.keyPem, "KEY");
  assert.deepEqual(c.covered, ["shop.lab.test"]);
  // A server that said it holds that pair is not sent the key again.
  assert.equal(p.certs("s3", "ab".repeat(32))[0].keyPem, "");
  // An expired pair is neither sent nor said to cover anything.
  const old = plan(
    [domain("a", "shop.lab.test")],
    [{ ...valid, notAfter: new Date(NOW - 1).toISOString() }],
  );
  assert.deepEqual(
    [
      old.certs("s2")[0].sha256,
      old.certs("s2")[0].keyPem,
      old.certs("s2")[0].covered,
    ],
    ["", "", []],
  );
});

test("renewers are handed the zone last", () => {
  const order = renewersLast(
    [member("s1", "1"), member("s2", "2"), member("s3", "3")],
    [zone({ renewerServerId: "s1" })],
  ).map((m) => m.serverId);
  assert.deepEqual(order, ["s2", "s3", "s1"]);
});

test("a failed order is said in plain words", () => {
  assert.match(
    zoneCertErrorWords(
      "acme: error: 400 :: urn:ietf:params:acme:error:dns :: NXDOMAIN looking up TXT for _acme-challenge.lab.test",
    ),
    /could not look the zone up/,
  );
  assert.match(
    zoneCertErrorWords("urn:ietf:params:acme:error:rateLimited"),
    /too many/,
  );
  assert.match(zoneCertErrorWords("something else"), /refused/);
  assert.match(
    zoneCertErrorWords(
      "acme: error: 400 :: POST :: https://pebble:14000/order-plz :: urn:ietf:params:acme:error:accountDoesNotExist",
    ),
    /asked pebble, not Let's Encrypt/,
  );
  assert.match(
    zoneCertErrorWords(
      "acme: error: 429 :: POST :: https://acme-v02.api.letsencrypt.org/acme/new-order :: rateLimited",
    ),
    /too many/,
  );
});

test("a shared name's check is its renewer's, and only an agent that holds such certificates is told of it", () => {
  const domains = [
    domain("d1", "shop.example.com", {
      inside: false,
      cnameSeen: true,
      serverId: "s2",
    }),
  ];
  const modes = domainModes(domains, {
    wildcard: true,
    eligible: true,
    shared: true,
  });
  assert.equal(modes.get("d1"), "shared");
  const names = [
    {
      zoneId: "z1",
      zone: "lab.test",
      name: "shop.example.com",
      renewerServerId: "s3",
      sha256: "ab".repeat(32),
      notAfter: new Date(NOW + 86_400_000).toISOString(),
      pair: { certPem: "CERT", keyPem: "KEY" },
    },
  ];
  const challenges = zoneChallenges({
    zones: [zone()],
    domains,
    modes,
    names,
    fingerprintOf: fp,
  });
  assert.equal(
    challenges.find((c) => c.asked === "_acme-challenge.shop.example.com")
      ?.ownerFingerprint,
    fp("s3"),
  );
  const certs = (serverId: string, shares: boolean, reported?: string) =>
    zoneCertificatesFor({
      serverId,
      zones: [zone()],
      domains,
      modes,
      names,
      shares,
      reported: () => reported,
      now: NOW,
    });
  assert.deepEqual(certs("s1", false), []);
  const [held] = certs("s1", true);
  assert.deepEqual(
    [held.names, held.renew, held.keyPem],
    [["shop.example.com"], false, "KEY"],
  );
  assert.equal(
    certs("s1", true, "ab".repeat(32))[0].keyPem,
    "",
    "the key goes once",
  );
  assert.equal(certs("s3", true)[0].renew, true);
  assert.deepEqual(
    renewersLast(
      [{ serverId: "s3" }, { serverId: "s1" }],
      [zone({ renewerServerId: null }), ...names],
    ).map((m) => m.serverId),
    ["s1", "s3"],
  );
});
