import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  __resetAgentAddressesForTest,
  __setAgentAddressesForTest,
  serverAddresses,
  serverIpv4,
} from "./addresses";
import {
  __resetDnsResolve4ForTest,
  __setDnsResolve4ForTest,
  __setDnsResolve6ForTest,
} from "../domains/dns-resolve";
import type { Server } from "../../types/server";

const PANEL_IP = "203.0.113.200";
const agent = {
  port: 9443,
  certFingerprint: "pin",
  certPem: "",
  version: "",
};
const at = (ip: string, withAgent = false): Server =>
  ({
    id: `srv_${ip}`,
    host: ip,
    ip,
    agent: withAgent ? agent : undefined,
  }) as unknown as Server;

before(() => {
  process.env.DEPLO_SERVER_IP = PANEL_IP;
});

beforeEach(() => {
  __setDnsResolve4ForTest(async (n) =>
    n === "box.example" ? ["198.51.100.7"] : [],
  );
  __setDnsResolve6ForTest(async (n) =>
    n === "box.example" ? ["2001:DB8::7"] : [],
  );
  __setAgentAddressesForTest(async () => null);
});

after(() => {
  delete process.env.DEPLO_SERVER_IP;
  __resetDnsResolve4ForTest();
  __resetAgentAddressesForTest();
});

test("a literal address is its own family; IPv6 is not known complete without the agent", async () => {
  assert.deepEqual(await serverAddresses(at("198.51.100.1")), {
    v4: ["198.51.100.1"],
    v6: [],
    v6Known: false,
  });
  assert.deepEqual(await serverAddresses(at("2001:0db8::1")), {
    v4: [],
    v6: ["2001:db8::1"],
    v6Known: false,
  });
});

test("a server added by name has its name's A and AAAA records, never the panel's", async () => {
  assert.deepEqual(await serverAddresses(at("box.example")), {
    v4: ["198.51.100.7"],
    v6: ["2001:db8::7"],
    v6Known: false,
  });
  assert.deepEqual((await serverAddresses(at("gone.example"))).v4, []);
});

test("an agent that reports its addresses makes the IPv6 list complete, even when empty", async () => {
  __setAgentAddressesForTest(async () => ["198.51.100.1", "2001:db8::42"]);
  assert.deepEqual(await serverAddresses(at("198.51.100.1", true)), {
    v4: ["198.51.100.1"],
    v6: ["2001:db8::42"],
    v6Known: true,
  });
  __setAgentAddressesForTest(async () => []);
  assert.equal((await serverAddresses(at("198.51.100.1", true))).v6Known, true);
});

test("an agent too old to report, or unreachable, leaves IPv6 unknown", async () => {
  __setAgentAddressesForTest(async () => null);
  assert.equal(
    (await serverAddresses(at("198.51.100.1", true))).v6Known,
    false,
  );
});

test("serverIpv4: a generated name gets this server's IPv4 or none, never the panel's for another machine", async () => {
  assert.equal(await serverIpv4(at("198.51.100.1")), "198.51.100.1");
  assert.equal(await serverIpv4(at("box.example")), "198.51.100.7");
  assert.equal(await serverIpv4(at("2001:db8::1")), null);
  assert.equal(await serverIpv4(at("gone.example")), null);
  __setAgentAddressesForTest(async () => ["198.51.100.9", "2001:db8::1"]);
  assert.equal(await serverIpv4(at("2001:db8::1", true)), "198.51.100.9");
  assert.equal(await serverIpv4(at("127.0.0.1")), PANEL_IP);
  assert.equal(await serverIpv4(null), PANEL_IP);
});

test("loopback, or no server at all, means the machine Deplo runs on", async () => {
  assert.deepEqual((await serverAddresses(at("127.0.0.1"))).v4, [PANEL_IP]);
  assert.deepEqual((await serverAddresses(at("localhost"))).v4, [PANEL_IP]);
  assert.deepEqual((await serverAddresses(null)).v4, [PANEL_IP]);
});
