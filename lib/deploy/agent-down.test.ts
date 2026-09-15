import test from "node:test";
import assert from "node:assert/strict";

import { AgentUnreachableError } from "../infra/agent-client/errors";
import { AgentUnavailableError } from "./agent-deploy";

test("the two agent-down errors are unrelated classes, so one instanceof is not enough", () => {
  const unreachable = new AgentUnreachableError("dial 10.0.0.5:9443 refused");
  const unavailable = new AgentUnavailableError("Docker is not available");

  assert.equal(
    unreachable instanceof AgentUnavailableError,
    false,
    "if this ever becomes true the guard below can be simplified - until then it must not be",
  );
  assert.equal(unavailable instanceof AgentUnreachableError, false);
});

function agentIsDown(e: unknown): boolean {
  return (
    e instanceof AgentUnavailableError || e instanceof AgentUnreachableError
  );
}

test("every agent-down error is recognised as down", () => {
  for (const e of [
    new AgentUnreachableError("connection refused"),
    new AgentUnreachableError("deadline exceeded", 4),
    new AgentUnavailableError("the agent reports Docker is not available"),
    new AgentUnavailableError("agent stream produced no events"),
  ]) {
    assert.equal(agentIsDown(e), true, `not recognised: ${e.constructor.name}`);
  }
});

test("an ordinary build failure is NOT treated as the host being down", () => {
  assert.equal(agentIsDown(new Error("npm run build exited 1")), false);
  assert.equal(agentIsDown(new TypeError("boom")), false);
  assert.equal(agentIsDown("nope"), false);
  assert.equal(agentIsDown(null), false);
});

function agentDownReason(e: unknown): string {
  if (e instanceof AgentUnavailableError) return e.message;
  if (e instanceof AgentUnreachableError && e.trust) {
    return "its certificate is not the one Deplo trusts - reissue its install command";
  }
  return "it did not answer";
}

test("a transport error's address never reaches the deploy log", () => {
  const raw = "14 UNAVAILABLE: No connection established to 10.0.0.5:9443";
  const reason = agentDownReason(new AgentUnreachableError(raw));
  assert.doesNotMatch(
    reason,
    /10\.0\.0\.5/,
    "the host address must not be echoed",
  );
  assert.doesNotMatch(reason, /9443/, "nor the agent port");
  assert.ok(reason.length > 0, "but the reader still gets a reason");
});

test("our own curated messages DO survive - they carry no address", () => {
  const msg = "the agent reports Docker is not available on the target server";
  assert.equal(agentDownReason(new AgentUnavailableError(msg)), msg);
});

test("a certificate failure does not read as a dead host", () => {
  const dead = new AgentUnreachableError("14 UNAVAILABLE: connection refused");
  const untrusted = new AgentUnreachableError(
    "14 UNAVAILABLE: handshake",
    14,
    true,
  );

  assert.match(agentDownReason(dead), /did not answer/);
  assert.match(agentDownReason(untrusted), /certificate/);
  assert.doesNotMatch(agentDownReason(untrusted), /did not answer/);
  assert.doesNotMatch(
    agentDownReason(untrusted),
    /UNAVAILABLE|handshake|\d+\.\d+\.\d+\.\d+/,
  );
});
