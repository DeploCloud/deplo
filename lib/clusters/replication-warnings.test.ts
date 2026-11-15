import { test } from "node:test";
import assert from "node:assert/strict";

import { composeClusterWarnings, replicationWarnings } from "./warnings";

test("an App with no whole copy on another server is named, with what that means", () => {
  const [w] = replicationWarnings([
    { appName: "web", following: 0, held: 0, total: 2, error: "" },
  ]);
  assert.equal(w.title, "Replication is not ready for 1 App yet");
  assert.equal(
    w.body,
    "A whole copy of their data is not on another server yet: web. Until it is, they wait for their own server.",
  );
});

test("a copy that stopped following says replication is behind, and why", () => {
  const out = replicationWarnings([
    {
      appName: "web",
      following: 1,
      held: 1,
      total: 2,
      error: "the server the App runs on refused",
    },
    { appName: "api", following: 1, held: 2, total: 2, error: "" },
    { appName: "docs", following: 2, held: 2, total: 2, error: "" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Replication is behind for 2 Apps");
  assert.equal(
    out[0].body,
    "web: the server the App runs on refused · api: 1 of 2 servers follow it",
  );
});

test("replication's banners show only while failover can use them", () => {
  const input = {
    servers: 2,
    leader: [],
    waiting: [],
    copies: [],
    replication: [
      { appName: "web", following: 0, held: 0, total: 1, error: "" },
    ],
  };
  assert.deepEqual(
    composeClusterWarnings({ ...input, failoverEnabled: false }),
    [],
  );
  assert.deepEqual(
    composeClusterWarnings({ ...input, failoverEnabled: true }).map(
      (w) => w.key,
    ),
    ["replication"],
  );
});
