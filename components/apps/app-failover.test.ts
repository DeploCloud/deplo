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
  sentence:
    "web waits for server-a if it stops, so it never starts on old files. You can bring it back on another server from its latest backup.",
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

test("an App with a Volume reads the two promises in the spec's words", () => {
  const card = text(failover());
  assert.match(card, /Never two writers/);
  assert.match(
    card,
    /A failover restores the latest backup, and says how old it was/,
  );
  assert.match(
    card,
    /Each backup pauses it for as long as its files take to copy\./,
  );
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
