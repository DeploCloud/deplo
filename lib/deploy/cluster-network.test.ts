import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_NETWORK_ENDPOINTS,
  networkAddress,
  networkEndpoints,
  planNetwork,
  type NetworkServer,
} from "./cluster-network";

const server = (
  id: string,
  over: Partial<NetworkServer> = {},
): NetworkServer => ({
  serverId: id,
  fingerprint: id.padEnd(64, "0"),
  publicKey: `key-${id}`,
  port: 51820,
  addresses: [`10.0.0.${id.length}`],
  ...over,
});

describe("cluster network plan (ADR-0047)", () => {
  test("a server's tunnel address comes from its id: the same everywhere, different for every server", () => {
    assert.equal(networkAddress("srv_a"), networkAddress("srv_a"));
    assert.notEqual(networkAddress("srv_a"), networkAddress("srv_b"));
    assert.match(networkAddress("srv_a"), /^fdde:9100:0:0(:[0-9a-f]{1,4}){4}$/);
  });

  test("a server is tried on each address it answers on, once, with its port", () => {
    assert.deepEqual(
      networkEndpoints(
        ["10.0.0.51", " 10.0.0.51", "2001:db8::1", "[2001:db8::1]"],
        51820,
      ),
      ["10.0.0.51:51820", "[2001:db8::1]:51820"],
    );
  });

  test("a hostname, an empty address or no port yet gives nothing to try", () => {
    assert.deepEqual(
      networkEndpoints(["eu-1.example.com", "", "0.0.0.0", "::"], 51820),
      [],
    );
    assert.deepEqual(networkEndpoints(["10.0.0.51"], 0), []);
    const many = Array.from({ length: 20 }, (_, i) => `10.0.1.${i + 1}`);
    assert.equal(networkEndpoints(many, 1).length, MAX_NETWORK_ENDPOINTS);
  });

  test("each server is handed every other one whose key is known, never itself", () => {
    const plan = planNetwork([
      server("a"),
      server("bb"),
      server("ccc", { publicKey: null }),
    ]);
    assert.deepEqual(
      plan.get("a")!.peers.map((p) => p.publicKey),
      ["key-bb"],
    );
    assert.deepEqual(
      plan
        .get("ccc")!
        .peers.map((p) => p.publicKey)
        .sort(),
      ["key-a", "key-bb"],
    );
    assert.equal(plan.get("a")!.address, networkAddress("a"));
    assert.deepEqual(plan.get("a")!.peers[0].endpoints, ["10.0.0.2:51820"]);
  });

  test("a server whose agent has named no port yet is reached through a relay only", () => {
    const plan = planNetwork([server("a"), server("bb", { port: 0 })]);
    assert.deepEqual(plan.get("a")!.peers[0].endpoints, []);
  });
});
