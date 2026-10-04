import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalHost,
  clientKeyAddress,
  formatHostPort,
  isIpLiteral,
  parseHostAddress,
} from "./host-address";

test("every spelling of one IPv6 address stores the same way", () => {
  for (const raw of [
    "2001:db8::1",
    "[2001:db8::1]",
    "2001:0db8:0:0::1",
    " 2001:DB8:0:0:0:0:0:1 ",
  ])
    assert.deepEqual(
      parseHostAddress(raw),
      { kind: "ipv6", host: "2001:db8::1" },
      raw,
    );
});

test("IPv4 and host names are kept, host names lowercased", () => {
  assert.deepEqual(parseHostAddress("203.0.113.10"), {
    kind: "ipv4",
    host: "203.0.113.10",
  });
  assert.deepEqual(parseHostAddress("Server.Example.com."), {
    kind: "hostname",
    host: "server.example.com",
  });
  assert.deepEqual(parseHostAddress("localhost"), {
    kind: "hostname",
    host: "localhost",
  });
});

test("anything that is none of the three is refused", () => {
  for (const raw of [
    "",
    "not an address!",
    "2001:db8::1::2",
    "[2001:db8::1",
    "300.1.1.1",
    "1.2.3",
    "-bad.example",
    "host:22",
    "fe80::1%eth0",
    "http://203.0.113.10",
  ])
    assert.equal(parseHostAddress(raw), null, raw);
});

test("a port after an IPv6 address gets brackets, nothing else does", () => {
  assert.equal(formatHostPort("2001:db8::1", 9443), "[2001:db8::1]:9443");
  assert.equal(formatHostPort("[2001:db8::1]", 9443), "[2001:db8::1]:9443");
  assert.equal(formatHostPort("203.0.113.10", 9443), "203.0.113.10:9443");
  assert.equal(formatHostPort("db.example.com", 5432), "db.example.com:5432");
});

test("clientKeyAddress: one IPv6 /64 is one client, a mapped IPv4 is its IPv4, the rest is unchanged", () => {
  assert.equal(clientKeyAddress("2001:db8:1:2::5"), "2001:db8:1:2::/64");
  assert.equal(
    clientKeyAddress("2001:DB8:1:2:aaaa:bbbb:cccc:dddd"),
    "2001:db8:1:2::/64",
  );
  assert.equal(clientKeyAddress("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKeyAddress("[2001:db8::1]"), "2001:db8:0:0::/64");
  assert.equal(clientKeyAddress("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(clientKeyAddress("203.0.113.5"), "203.0.113.5");
  assert.equal(clientKeyAddress("unknown"), "unknown");
});

test("canonicalHost compares two spellings, and isIpLiteral knows both families", () => {
  assert.equal(
    canonicalHost("[2001:0DB8::0001]"),
    canonicalHost("2001:db8::1"),
  );
  assert.equal(canonicalHost("  weird value "), "weird value");
  assert.equal(isIpLiteral("2001:db8::1"), true);
  assert.equal(isIpLiteral("203.0.113.10"), true);
  assert.equal(isIpLiteral("server.example.com"), false);
});
