import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import { renderServerView } from "@/components/servers/server-test-helpers";
import { AppServerCard } from "./server-move-card";

const eu = { id: "clu_1", name: "eu", isDeploHost: false, kind: "cluster" };
const card = (
  servers: (typeof eu | { id: string; name: string; isDeploHost: boolean })[],
) =>
  renderServerView(
    createElement(AppServerCard, {
      appId: "prj_1",
      name: "web",
      serverId: "srv_2",
      servers: servers as Parameters<typeof AppServerCard>[0]["servers"],
      neighbours: [],
      cluster: { id: "clu_1", name: "eu", serverName: "server-b" },
    }),
  ).replace(/<[^>]+>/g, "");

test("a cluster App says where it runs when its cluster is the only place it can be", () => {
  const html = card([eu]);
  assert.match(html, /Runs on eu · now on server-b/);
  assert.doesNotMatch(html, /Move/);
});

test("with another place to go, the same line sits beside Move", () => {
  const html = card([
    eu,
    { id: "srv_9", name: "server-z", isDeploHost: false },
  ]);
  assert.match(html, /Runs on eu · now on server-b/);
  assert.match(html, /Move/);
});
