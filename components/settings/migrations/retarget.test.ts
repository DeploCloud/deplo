import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcilePlacements } from "./migration-wizard";
import type { Placement, ServerChoice } from "./types";

/**
 * What a change of target team does to the hosts already picked.
 */

const HOME: ServerChoice = {
  id: "srv_home",
  name: "eu-main-1",
  isDeploHost: true,
};
const SHARED: ServerChoice = { id: "srv_shared", name: "eu-2" };
const BUILDER: ServerChoice = {
  id: "srv_build",
  name: "builder",
  buildOnly: true,
};

const PLACED: Record<string, Placement> = {
  web: { serverId: "srv_other", buildServerId: "srv_gone" },
  api: { serverId: "srv_shared", buildServerId: null },
  db: { serverId: "srv_home", buildServerId: null, exposedPort: 5433 },
};
/** Source machine -> the Deplo server it lands on. */
const MACHINES = { "": "srv_other", "dok-srv-1": "srv_shared" };

test("a host the new team cannot use falls back, the rest is untouched", () => {
  const next = reconcilePlacements(
    PLACED,
    MACHINES,
    [HOME, SHARED],
    [HOME, BUILDER],
  );

  // `srv_other` belongs to a team this one is not in: keeping it would send a
  // migration that dies at `createApp` with every source service already stopped.
  assert.equal(next.placements.web.serverId, "srv_home");
  assert.equal(next.placements.web.buildServerId, null);
  assert.equal(next.placements.api.serverId, "srv_shared");
  assert.equal(next.placements.db.serverId, "srv_home");
  // The port the review settled on is a decision, not a placement.
  assert.equal(next.placements.db.exposedPort, 5433);
  // The machine map is sent with the run too, so it reads the same way.
  assert.deepEqual(next.servers, {
    "": "srv_home",
    "dok-srv-1": "srv_shared",
  });
});

test("a team with no server at all keeps what was picked", () => {
  // There is nothing to fall back TO, and the review already refuses to start.
  const next = reconcilePlacements(PLACED, MACHINES, [], []);
  assert.equal(next.placements, PLACED);
  assert.equal(next.servers, MACHINES);
});
