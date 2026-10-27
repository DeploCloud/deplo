import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import type { AgentUpdateDTO } from "@/lib/data/servers/agent-update-state";
import { AgentUpdateStatus } from "./agent-update-status";
import { renderServerView } from "./server-test-helpers";

const retrying: AgentUpdateDTO = {
  running: false,
  failed: true,
  gaveUp: false,
  attempts: 1,
  failure: "unreachable",
  lastError: "offline",
  firstFailedAt: "2026-10-20T10:00:00Z",
  nextRetryAt: "2026-10-20T10:04:00Z",
};

// A render is the same on the server and in the browser; the countdown comes after it.
test("the status line reads no clock while it renders", (t) => {
  t.mock.method(Date, "now", () => {
    throw new Error("the clock was read during render");
  });
  const html = renderServerView(
    createElement(AgentUpdateStatus, {
      serverId: "srv_one",
      reach: "usable",
      update: retrying,
    }),
  );
  assert.match(html, /Update failed/);
  assert.match(html, /Retry now/);
});
