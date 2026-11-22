import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import { renderServerView } from "@/components/servers/server-test-helpers";
import { TraefikRestartWords } from "./traefik-restart-words";

const text = (cluster: string | null) =>
  renderServerView(createElement(TraefikRestartWords, { cluster }))
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&apos;/g, "'");

test("a cluster member's restart rolls: it leaves the answers, and only an App on it alone notices", () => {
  const t = text("eu");
  assert.match(
    t,
    /leaves cluster eu's answers first, restarts Traefik and is back in them in about 30 seconds/,
  );
  assert.match(t, /Apps on the other servers are not affected/);
  assert.match(
    t,
    /an App that runs only on this server is unreachable for a few seconds/,
  );
  assert.doesNotMatch(t, /Every site on this server/);
});

test("a standalone server keeps today's words", () => {
  assert.match(text(null), /Every site on this server is unreachable/);
});
