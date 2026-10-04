import { test } from "node:test";
import assert from "node:assert/strict";

import { remoteTarget } from "./mtls-channel";
import type { Server } from "../../types/server";

process.env.DEPLO_SECRET = "test-secret-for-remote-target-aaaaaaaaa";

const at = (ip: string): Server =>
  ({
    id: "srv_t",
    name: "t",
    host: ip,
    ip,
    agent: { port: 9443, certFingerprint: "abc", certPem: "", version: "" },
  }) as unknown as Server;

// grpc-js reads `2001:db8::1:9443` as one address with no port and dials 443.
test("an IPv6 agent is dialled in brackets, under the localhost TLS name", async () => {
  const t = await remoteTarget(at("2001:db8::1"));
  assert.equal(t.address, "[2001:db8::1]:9443");
  assert.equal(t.serverName, "localhost");
});

test("IPv4 and host names keep their old target", async () => {
  const v4 = await remoteTarget(at("203.0.113.10"));
  assert.equal(v4.address, "203.0.113.10:9443");
  assert.equal(v4.serverName, "localhost");
  const named = await remoteTarget(at("agent.example.com"));
  assert.equal(named.address, "agent.example.com:9443");
  assert.equal(named.serverName, "agent.example.com");
});
