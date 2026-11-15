import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import { renderServerView } from "@/components/servers/server-test-helpers";
import type { AppFailover } from "@/lib/data/apps/failover";
import { AppFailoverCard } from "./app-failover";

const failover = (over: Partial<AppFailover> = {}): AppFailover => ({
  cluster: "eu",
  serverName: "server-a",
  disk: "volume",
  automatic: false,
  replicatedTo: 0,
  upToDateAt: null,
  heldBy: 0,
  sentence:
    "web waits for server-a if it stops: cluster eu does not copy its data. You can bring it back on another server from its latest backup.",
  waiting: false,
  bringBack: null,
  why: null,
  ...over,
});

const text = (f: AppFailover) =>
  renderServerView(createElement(AppFailoverCard, { failover: f })).replace(
    /<[^>]+>/g,
    " ",
  );

test("a replicated App with a Volume reads the two promises and how far its copies follow", () => {
  const card = text(
    failover({
      automatic: true,
      replicatedTo: 2,
      heldBy: 2,
      upToDateAt: new Date(Date.now() - 1_000).toISOString(),
    }),
  );
  assert.match(card, /Never two writers/);
  assert.match(
    card,
    /A failover starts it from its copy on the new server, as up to date as the copy was/,
  );
  assert.match(card, /Replicated to\s+2 servers\s*, up to date/);
});

test("an App with a Volume on a cluster that does not replicate is promised no failover", () => {
  const card = text(failover());
  assert.match(card, /cluster eu does not copy its data/);
  assert.doesNotMatch(card, /Never two writers|Replicated to/);
});

test("an App with a Bind never fails over, so it is promised nothing about one", () => {
  const card = text(
    failover({
      disk: "bind",
      sentence:
        "web never fails over: it uses a folder that lives on server-a, and only on that machine.",
    }),
  );
  assert.match(card, /web never fails over/);
  assert.doesNotMatch(card, /Never two writers|latest backup/);
});
