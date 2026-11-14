import { test, after } from "node:test";
import assert from "node:assert/strict";

import type { AgentClient, HelloResponse } from "../../agent/gen/agent";
import {
  admitLink,
  doorClosed,
  doorOpened,
  linkEnded,
  linkGeneration,
  serverAnswers,
  type AgentLink,
} from "./registry";
import { LINK_SETTLE_MS, LINK_SILENT_MS } from "./protocol";

const SERVER = "srv_answers";

function fakeLink(heard: () => number): AgentLink {
  const link: AgentLink = {
    id: 1,
    serverId: SERVER,
    pinnedFingerprint: "fp",
    client: {} as AgentClient,
    hello: {} as HelloResponse,
    openedAt: Date.now(),
    heardAt: heard,
    close: () => linkEnded(link, "closed"),
  };
  return link;
}

after(() => doorClosed());

test("a process with no link door cannot tell", () => {
  doorClosed();
  assert.equal(serverAnswers(SERVER), null);
});

test("right after the door opens, a server that has not linked yet is unknown", () => {
  doorOpened();
  assert.equal(serverAnswers(SERVER), null);
  doorOpened(Date.now() - LINK_SETTLE_MS);
  assert.equal(
    serverAnswers(SERVER),
    false,
    "settled and no link: not answering",
  );
});

test("a server answers only while it was heard in the last few seconds", () => {
  doorOpened(Date.now() - LINK_SETTLE_MS);
  let heard = Date.now();
  const link = fakeLink(() => heard);
  assert.ok(admitLink(link, linkGeneration(SERVER)));
  assert.equal(serverAnswers(SERVER), true);
  // A crashed server sends no close: the link is still there, and silent.
  heard = Date.now() - LINK_SILENT_MS - 1;
  assert.equal(serverAnswers(SERVER), false);
});

test("a link that just dropped still answers until its silence runs out", () => {
  doorOpened(Date.now() - LINK_SETTLE_MS);
  let heard = Date.now();
  const link = fakeLink(() => heard);
  assert.ok(admitLink(link, linkGeneration(SERVER)));
  link.close(1000, "done");
  assert.equal(serverAnswers(SERVER), true, "a reconnect is not an outage");
  doorClosed();
  doorOpened(Date.now() - LINK_SETTLE_MS);
  heard = Date.now() - LINK_SILENT_MS - 1;
  const old = fakeLink(() => heard);
  assert.ok(admitLink(old, linkGeneration(SERVER)));
  old.close(1000, "done");
  assert.equal(serverAnswers(SERVER), false);
});
