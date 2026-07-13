import { test } from "node:test";
import assert from "node:assert/strict";
import { status as GrpcStatus } from "@grpc/grpc-js";

import { AgentUnreachableError } from "./agent-client";
import {
  classifyServerHealth,
  isRetryableProbeFailure,
  HEALTH_MESSAGES,
} from "./server-health";
import { ContractVersion, type HelloResponse } from "../agent/gen/agent";

/**
 * The health classifier, tested without a socket.
 *
 * This is the whole reason the decision is hoisted out of the dial: there is no
 * mocking seam for `connectAgent` in this repo, so a classification welded to the RPC
 * (the shape `metricsFor` uses) is one that can never be exercised. Every row of the
 * state table in lib/types.ts `ServerStatus` is pinned here.
 */

function hello(over: Partial<HelloResponse> = {}): HelloResponse {
  return {
    contractVersion: ContractVersion.CONTRACT_VERSION_V1,
    agentVersion: "1.2.3",
    dockerAvailable: true,
    dockerVersion: "27.0",
    capabilities: [],
    traefikRunning: true,
    ...over,
  } as HelloResponse;
}

test("a healthy Hello is online, with no message to explain away", () => {
  const h = classifyServerHealth(hello(), null);
  assert.equal(h.status, "online");
  assert.equal(h.message, null);
});

test("Docker unreachable is `warning`, not offline — the agent answered", () => {
  const h = classifyServerHealth(hello({ dockerAvailable: false }), null);
  assert.equal(h.status, "warning");
  assert.equal(h.message, HEALTH_MESSAGES.dockerDown);
});

test("Traefik being down is NOT a warning — a DB/worker host legitimately has none", () => {
  // It has its own badge, and a status that fires on a normal configuration is a
  // status operators learn to ignore.
  const h = classifyServerHealth(hello({ traefikRunning: false }), null);
  assert.equal(h.status, "online");
});

test("an unsupported contract version is `error` — the box is up, its agent is wrong", () => {
  const h = classifyServerHealth(
    hello({ contractVersion: ContractVersion.CONTRACT_VERSION_UNSPECIFIED }),
    null,
  );
  assert.equal(h.status, "error");
  assert.equal(h.message, HEALTH_MESSAGES.contract);
});

test("connection refused is offline", () => {
  const err = new AgentUnreachableError("no connection", GrpcStatus.UNAVAILABLE);
  const h = classifyServerHealth(null, err);
  assert.equal(h.status, "offline");
  assert.equal(h.message, HEALTH_MESSAGES.refused);
});

test("a deadline overrun is offline, and says so specifically", () => {
  const err = new AgentUnreachableError("deadline", GrpcStatus.DEADLINE_EXCEEDED);
  const h = classifyServerHealth(null, err);
  assert.equal(h.status, "offline");
  assert.equal(h.message, HEALTH_MESSAGES.timedOut);
});

test("a cert-pin mismatch is `error`, NEVER offline — the peer answered, it just isn't ours", () => {
  // This is the case gRPC flattens into an opaque UNAVAILABLE. Reporting it as
  // "offline" would send an operator to check a host that is up, and would bury what
  // may be a MITM or a half-finished re-provision.
  const err = new AgentUnreachableError(
    "agent cert fingerprint mismatch: pinned abc123, got def456",
    GrpcStatus.UNAVAILABLE,
    true,
  );
  const h = classifyServerHealth(null, err);
  assert.equal(h.status, "error");
  assert.equal(h.message, HEALTH_MESSAGES.untrusted);
});

test("an agent that rejects OUR client cert (UNAUTHENTICATED) is a trust error too", () => {
  const err = new AgentUnreachableError("unauthenticated", GrpcStatus.UNAUTHENTICATED, true);
  assert.equal(classifyServerHealth(null, err).status, "error");
});

test("an application-level gRPC error is `error`", () => {
  const err = Object.assign(new Error("failed precondition"), {
    code: GrpcStatus.FAILED_PRECONDITION,
  });
  const h = classifyServerHealth(null, err);
  assert.equal(h.status, "error");
  assert.equal(h.message, HEALTH_MESSAGES.agentError);
});

test("the persisted message NEVER leaks the pinned fingerprint or the dial address", () => {
  // `status_message` is stored and served over GraphQL. checkServerIdentity's raw text
  // carries our trust anchor; grpc-js UNAVAILABLE details routinely carry `10.x.x.x:9443`.
  // Neither may survive classification — this is the assertion that keeps the closed
  // message set closed.
  const raw =
    "14 UNAVAILABLE: agent cert fingerprint mismatch: pinned deadbeefcafe, got 0badf00d (10.4.2.9:9443)";
  const messages = [
    classifyServerHealth(null, new AgentUnreachableError(raw, GrpcStatus.UNAVAILABLE, true)),
    classifyServerHealth(null, new AgentUnreachableError(raw, GrpcStatus.UNAVAILABLE)),
    classifyServerHealth(null, Object.assign(new Error(raw), { code: GrpcStatus.INTERNAL })),
  ].map((h) => h.message ?? "");

  for (const msg of messages) {
    assert.ok(!/fingerprint/i.test(msg), `leaked the word fingerprint: ${msg}`);
    assert.ok(!/deadbeefcafe|0badf00d/i.test(msg), `leaked cert material: ${msg}`);
    assert.ok(!/10\.4\.2\.9|9443/.test(msg), `leaked the dial address: ${msg}`);
    assert.ok(
      Object.values(HEALTH_MESSAGES).includes(msg as (typeof HEALTH_MESSAGES)[keyof typeof HEALTH_MESSAGES]),
      `message escaped the closed set: ${msg}`,
    );
  }
});

test("only a transport failure is worth a confirming retry", () => {
  // A blip deserves a second look; a trust failure or an application error is a stable
  // fact that a retry would only confirm more slowly.
  assert.equal(
    isRetryableProbeFailure(new AgentUnreachableError("blip", GrpcStatus.UNAVAILABLE)),
    true,
  );
  assert.equal(
    isRetryableProbeFailure(new AgentUnreachableError("bad cert", GrpcStatus.UNAVAILABLE, true)),
    false,
  );
  assert.equal(isRetryableProbeFailure(new Error("app error")), false);
});
