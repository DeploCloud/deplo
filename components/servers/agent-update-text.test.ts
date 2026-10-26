import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentUpdateDTO } from "@/lib/data/servers/agent-update-state";
import { agentUpdateText, unusableAgentsMessage } from "./agent-update-text";

const NOW = Date.parse("2026-10-20T10:00:00Z");
const failed = (patch: Partial<AgentUpdateDTO> = {}): AgentUpdateDTO => ({
  running: false,
  failed: true,
  gaveUp: false,
  attempts: 1,
  failure: "unreachable",
  lastError: "boom",
  firstFailedAt: new Date(NOW).toISOString(),
  nextRetryAt: new Date(NOW + 3.2 * 60_000).toISOString(),
  ...patch,
});

test("a usable server with nothing in flight says nothing", () => {
  assert.equal(agentUpdateText(null, true, NOW), null);
});

test("each state reads as one line, unusable first", () => {
  assert.equal(
    agentUpdateText(null, false, NOW),
    "Unusable - Deplo is updating it",
  );
  assert.equal(
    agentUpdateText(failed(), true, NOW),
    "Update failed, retrying in 4 min",
  );
  assert.equal(
    agentUpdateText(failed({ failure: "busy" }), true, NOW),
    "Waiting for a deploy to finish, retrying in 4 min",
  );
  assert.equal(
    agentUpdateText(failed({ gaveUp: true, nextRetryAt: null }), false, NOW),
    "Unusable - Update failed (gave up after 24 h)",
  );
  assert.equal(
    agentUpdateText(failed({ running: true }), true, NOW),
    "Updating the agent",
  );
  assert.equal(
    agentUpdateText(
      failed({ nextRetryAt: new Date(NOW - 1).toISOString() }),
      true,
      NOW,
    ),
    "Update failed, retrying now",
  );
});

// It cannot reach this Deplo at all (ADR-0040), so nothing Deplo does will update it.
test("an agent too old to link is told to be reinstalled, never promised an update", () => {
  assert.equal(
    agentUpdateText(null, false, NOW, false),
    "Unusable - reinstall its agent",
  );
});

test("the banner waits for an update only where one can come", () => {
  const ready = { name: "eu-1", links: true };
  const stuck = { name: "eu-2", links: false };
  assert.equal(
    unusableAgentsMessage([ready]),
    "eu-1 is unusable until its agent updates.",
  );
  assert.equal(
    unusableAgentsMessage([stuck]),
    "eu-2 is unusable until its agent is reinstalled.",
  );
  assert.equal(
    unusableAgentsMessage([ready, { ...ready, name: "eu-3" }]),
    "2 servers are unusable until their agents update.",
  );
  assert.equal(
    unusableAgentsMessage([ready, stuck]),
    "2 servers are unusable until their agents update or are reinstalled.",
  );
});
