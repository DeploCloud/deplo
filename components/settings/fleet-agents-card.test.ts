import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import { renderServerView } from "@/components/servers/server-test-helpers";
import { FleetAgentsCard, type FleetSummary } from "./fleet-agents-card";

const fleet = (over: Partial<FleetSummary> = {}): FleetSummary => ({
  expected: "0.5.0",
  minimum: "0.4.0",
  total: 3,
  behind: [],
  updating: false,
  pausedBy: null,
  ...over,
});

const render = (f: FleetSummary) =>
  renderServerView(
    createElement(FleetAgentsCard, { fleet: f, onSettled() {} }),
  );

test("a server Deplo is still updating gets no button", () => {
  const html = render(
    fleet({
      updating: true,
      behind: [
        {
          id: "s1",
          name: "edge-1",
          version: "0.4.0",
          usable: true,
          update: null,
        },
      ],
    }),
  );
  assert.ok(html.includes("edge-1"));
  assert.ok(!html.includes("Retry now"));
});

test("a failed update shows its state and Retry now; a pause is named", () => {
  const html = render(
    fleet({
      pausedBy: "edge-2",
      behind: [
        {
          id: "s2",
          name: "edge-2",
          version: "0.3.0",
          usable: false,
          update: {
            running: false,
            failed: true,
            gaveUp: true,
            attempts: 12,
            failure: "no_return",
            lastError: "did not come back",
            firstFailedAt: "2026-10-19T10:00:00Z",
            nextRetryAt: null,
          },
        },
      ],
    }),
  );
  assert.ok(html.includes("Unusable - Update failed (gave up after 24 h)"));
  assert.ok(html.includes("Retry now"));
  assert.ok(html.includes("Waiting for edge-2 to recover"));
});
