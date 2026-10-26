import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import { renderServerView } from "@/components/servers/server-test-helpers";
import { FleetBehind, type FleetSummary } from "./fleet-agents";

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
  renderServerView(createElement(FleetBehind, { fleet: f, onSettled() {} }));

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
          // Below a later minimum, but new enough to link.
          version: "0.5.1",
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

test("an agent too old to link is told to be reinstalled, with no Retry now", () => {
  const html = render(
    fleet({
      behind: [
        {
          id: "s3",
          name: "edge-3",
          version: "0.4.0",
          usable: false,
          update: {
            running: false,
            failed: true,
            gaveUp: false,
            attempts: 1,
            failure: "unreachable",
            lastError: "offline",
            firstFailedAt: "2026-10-19T10:00:00Z",
            nextRetryAt: "2026-10-19T10:01:00Z",
          },
        },
      ],
    }),
  );
  assert.ok(html.includes("Unusable - reinstall its agent"));
  assert.ok(!html.includes("Retry now"));
});
