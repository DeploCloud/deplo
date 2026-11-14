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
import { LINK_SILENT_MS } from "./protocol";

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

test("a server answers only while its link was heard moments ago", () => {
  doorOpened();
  assert.equal(serverAnswers(SERVER), false, "no link: not answering");
  let heard = Date.now();
  const link = fakeLink(() => heard);
  assert.ok(admitLink(link, linkGeneration(SERVER)));
  assert.equal(serverAnswers(SERVER), true);
  // A crashed server sends no close: the link is still there, and silent.
  heard = Date.now() - LINK_SILENT_MS - 1;
  assert.equal(serverAnswers(SERVER), false);
  link.close(1000, "done");
  assert.equal(serverAnswers(SERVER), false);
});
