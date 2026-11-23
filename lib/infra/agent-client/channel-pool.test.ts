import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentClient, HelloResponse } from "../../agent/gen/agent";
import {
  admitLink,
  doorOpened,
  linkEnded,
  linkGeneration,
  nextLinkId,
} from "../agent-link/registry";
import { serverChannel } from "./channel-pool";
import { AgentOfflineError } from "./errors";

// A dead leader and a dead member cost Deplo 10 s per call each, in turn: it adopted the next leader after 80 s.

test("a server silent for longer than the link wait fails a call at once, not after the wait", async () => {
  doorOpened(Date.now() - 60_000);
  const serverId = "srv_gone";
  const link = {
    id: nextLinkId(),
    serverId,
    pinnedFingerprint: "f".repeat(64),
    client: {} as AgentClient,
    hello: {} as HelloResponse,
    openedAt: Date.now() - 60_000,
    heardAt: () => Date.now() - 30_000,
    close: () => {},
  };
  assert.ok(admitLink(link, linkGeneration(serverId)));
  linkEnded(link, "silent");
  const started = Date.now();
  await assert.rejects(
    serverChannel(serverId, "f".repeat(64)),
    AgentOfflineError,
  );
  assert.ok(Date.now() - started < 3_000, `waited ${Date.now() - started} ms`);
});
