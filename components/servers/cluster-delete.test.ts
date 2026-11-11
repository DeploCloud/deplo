import { test } from "node:test";
import assert from "node:assert/strict";

import type { ClusterDeletion } from "@/lib/types/cluster";
import { deletionCost } from "./cluster-delete";

const web = {
  kind: "app" as const,
  name: "web",
  serverName: "server-a",
  stopsOn: [],
  waiting: false,
  losesReach: [],
};
const deletion = (over: Partial<ClusterDeletion> = {}): ClusterDeletion => ({
  failoverOn: true,
  workloads: [web],
  otherTeams: [],
  ...over,
});

test("deleting a cluster that fails over says what stops: failover, and names across its servers", () => {
  assert.equal(
    deletionCost(deletion()),
    "These stop failing over, and an App stops reaching a database on another server by name. If a server stops, what runs on it stays down.",
  );
  // Another team's work counts too, though it is never named.
  assert.ok(
    deletionCost(
      deletion({
        workloads: [],
        otherTeams: [{ teamName: "Acme", apps: 1, databases: 0 }],
      }),
    ),
  );
});

test("a cluster of one, or an empty one, costs nothing to delete", () => {
  assert.equal(deletionCost(deletion({ failoverOn: false })), undefined);
  assert.equal(deletionCost(deletion({ workloads: [] })), undefined);
});
