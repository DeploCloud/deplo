import { test } from "node:test";
import assert from "node:assert/strict";

import { agentBadge } from "@/app/(dashboard)/[team]/settings/servers/agent-version-badge";
import {
  AGENT_REINSTALL_MESSAGE,
  cantReachDeploMessage,
} from "@/lib/agent-reachability";
import { AGENT_TOO_OLD_MESSAGE } from "@/lib/version";

const EXPECTED = "0.6.0";

test("a server below the floor that Deplo can reach is told it is being updated", () => {
  const badge = agentBadge("0.5.1-canary.10", EXPECTED, "updatable", "0.5.1");
  assert.equal(badge.label, "Agent too old");
  assert.equal(badge.tip, AGENT_TOO_OLD_MESSAGE);
});

// Nothing Deplo does reaches these (ADR-0041): the badge never promises an update.
test("a server only a reinstall or a connection brings back is told what does", () => {
  assert.equal(
    agentBadge("0.4.0", EXPECTED, "reinstall", "0.5.1").tip,
    AGENT_REINSTALL_MESSAGE,
  );
  for (const version of ["0.5.1-canary.10", "0.5.1"])
    assert.equal(
      agentBadge(version, EXPECTED, "unlinked", "0.5.1").tip,
      cantReachDeploMessage(null),
    );
});

test("a usable server behind the pin is updated on its own; one on the pin says nothing", () => {
  assert.equal(
    agentBadge("0.5.1", EXPECTED, "usable", "0.5.1").tip,
    "This Deplo runs agent v0.6.0. Deplo updates this server on its own.",
  );
  assert.equal(agentBadge(EXPECTED, EXPECTED, "usable", "0.5.1").tip, null);
});
