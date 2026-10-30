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
          reach: "usable",
          update: null,
        },
      ],
    }),
  );
  assert.ok(html.includes("edge-1"));
  assert.ok(!html.includes("Retry now"));
});

// Nothing Deplo does reaches them (ADR-0041): no spinner, no button, no promise of an update.
test("a server only a reinstall or a connection brings back is never shown as being updated", () => {
  const stuck = (id: string, reach: "reinstall" | "unlinked") => ({
    id,
    name: id,
    version: reach === "reinstall" ? "0.4.0" : null,
    reach,
    update: null,
  });
  const behind = [
    stuck("edge-3", "reinstall"),
    stuck("edge-4", "unlinked"),
    stuck("edge-5", "unlinked"),
    stuck("edge-6", "reinstall"),
  ];
  const html = render(fleet({ behind }));
  assert.ok(!html.includes("animate-spin"), "no spinner");
  assert.ok(!html.includes("Retry now"));
  assert.ok(html.includes("Unusable - reinstall its server agent"));
  assert.ok(html.includes("Unusable - it hasn&#x27;t connected to Deplo yet"));
});

test("the list of servers behind promises an update only where one can come", async () => {
  const { behindDescription } = await import("./fleet-agents");
  const line = (reach: "updatable" | "reinstall" | "unlinked") => ({ reach });
  assert.equal(
    behindDescription([line("updatable"), line("updatable")]),
    "Deplo updates each of them on its own, and retries a failed update for 24 hours.",
  );
  assert.equal(
    behindDescription([line("updatable"), line("reinstall")]),
    "Deplo updates the servers it can reach on its own, and retries a failed update for 24 hours. Each line says what the others need.",
  );
  assert.equal(
    behindDescription([line("unlinked"), line("reinstall")]),
    "Deplo can't reach these servers to update them. Each line says what brings one back.",
  );
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
          reach: "updatable",
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
