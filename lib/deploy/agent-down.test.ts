import test from "node:test";
import assert from "node:assert/strict";

import { AgentUnreachableError } from "../infra/agent-client";
import { AgentUnavailableError } from "./agent-deploy";

/**
 * The two error classes a dead host can produce, and why the build-server fallback
 * has to know about BOTH.
 *
 * They are unrelated types with near-identical names, and nothing at a call site
 * hints at which one arrives: `agentPreflight` rejects with `AgentUnreachableError`
 * (the dial or the Hello failed - the ordinary "the box is down"), while
 * `runAgentDeploy` raises `AgentUnavailableError` for its own refusals. Matching
 * only the second is exactly how a fallback written for "the build server is down"
 * never fires for it, and a suite with one server in it never notices.
 */

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

/**
 * The predicate `lib/deploy/build.ts` uses, restated here. It is not exported (it
 * is one line of a private module), so this pins the CONTRACT it has to satisfy:
 * every way a host can be down has to answer true.
 */
function agentIsDown(e: unknown): boolean {
  return e instanceof AgentUnavailableError || e instanceof AgentUnreachableError;
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
  // The distinction the fallback rests on: a build that RAN and failed must not be
  // retried on another host, because it would fail there identically.
  assert.equal(agentIsDown(new Error("npm run build exited 1")), false);
  assert.equal(agentIsDown(new TypeError("boom")), false);
  assert.equal(agentIsDown("nope"), false);
  assert.equal(agentIsDown(null), false);
});

/**
 * The message the deploy log is allowed to carry. A raw gRPC transport error
 * embeds the dial address, and a deploy log is readable by anyone with
 * `view_logs` - a lower bar than the fleet page that address belongs to.
 */
function agentDownReason(e: unknown): string {
  if (e instanceof AgentUnavailableError) return e.message;
  return "it did not answer";
}

test("a transport error's address never reaches the deploy log", () => {
  const raw = "14 UNAVAILABLE: No connection established to 10.0.0.5:9443";
  const reason = agentDownReason(new AgentUnreachableError(raw));
  assert.doesNotMatch(reason, /10\.0\.0\.5/, "the host address must not be echoed");
  assert.doesNotMatch(reason, /9443/, "nor the agent port");
  assert.ok(reason.length > 0, "but the reader still gets a reason");
});

test("our own curated messages DO survive - they carry no address", () => {
  const msg = "the agent reports Docker is not available on the target server";
  assert.equal(agentDownReason(new AgentUnavailableError(msg)), msg);
});
