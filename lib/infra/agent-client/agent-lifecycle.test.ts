import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { AgentConnection } from "./connection";
import { __setAgentConnectorForTest } from "./connect";
import { SELF_UPDATE_CAPABILITY } from "./hello-capabilities";
import { selfUpdateServerAgent } from "./agent-lifecycle";
import { SELF_UPDATE_TIMEOUT_MS } from "./deadlines";
import { __resetReleaseCacheForTests } from "../../agent/release";
import { setStoredPublicBaseUrl } from "../../public-url";

afterEach(() => {
  __setAgentConnectorForTest();
  __resetReleaseCacheForTests();
  setStoredPublicBaseUrl(null);
});

/**
 * An agent as old as v0.5.3-canary.30: it answers SelfUpdate only once it has downloaded and staged the binary from
 * the URL it is given. From GitHub that takes longer than Deplo waits (a server that reaches GitHub slowly), from
 * Deplo's own address it is quick.
 */
function oldAgent(seen: string[]): AgentConnection {
  return {
    hello: async () => ({
      agentVersion: "0.5.3-canary.30",
      capabilities: [SELF_UPDATE_CAPABILITY],
    }),
    selfUpdate: async (
      version: string,
      binaries: Record<string, { url: string; sha256: string }>,
    ) => {
      const url = binaries.amd64!.url;
      seen.push(url);
      if (new URL(url).hostname === "github.com")
        throw new Error(
          `4 DEADLINE_EXCEEDED: Deadline exceeded after ${SELF_UPDATE_TIMEOUT_MS / 1000}s`,
        );
      return { version, restarting: true };
    },
    close() {},
  } as unknown as AgentConnection;
}

// The owner's Deplo on canary.89, 24 Nov 2026: eu-1 and eu-2 on canary.30 failed every update with DEADLINE_EXCEEDED.
test("an old agent downloads the update from Deplo, with the release's checksum, and updates in time", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      `${"a".repeat(64)}  deplo-agent-linux-amd64\n`,
    )) as typeof fetch;
  setStoredPublicBaseUrl("https://deplo.example.com");
  const seen: string[] = [];
  __setAgentConnectorForTest(async () => oldAgent(seen));
  try {
    const res = await selfUpdateServerAgent("srv_1");
    assert.equal(res.restarting, true);
    assert.equal(
      seen[0],
      "https://deplo.example.com/api/agent/release/deplo-agent-linux-amd64",
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("an agent is given time for a slow link", () => {
  assert.ok(SELF_UPDATE_TIMEOUT_MS >= 10 * 60_000);
});
