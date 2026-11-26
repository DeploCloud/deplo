import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import type { TestDb } from "../db/test-harness";
import { teams } from "../db/schema/control-plane/identity";
import { clusterNetworkLinks } from "../db/schema/control-plane/clusters";
import { nowIso } from "../ids";
import { __forgetMemberProbes } from "../infra/agent-client/cluster-host";
import type { FakeClusterHost } from "../infra/agent-client/cluster-test-helpers";
import { CLUSTER_SUCCESSION_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { handLeadersOff, placeClusterLeaders } from "./clusters/leader-move";
import { getClusterById } from "./clusters/roster";
import { __forgetHeirsForTest, clusterHeirs } from "./clusters/succession";
import { leaderLab } from "./cluster-leader-test-helpers";
import { TEAM_B } from "./identity-test-helpers";

const lab = leaderLab();
const { asAdmin, eu, messages, stored } = lab;

let db: TestDb;
let hosts: Record<string, FakeClusterHost>;
beforeEach(async () => {
  ({ db, hosts } = lab);
  __forgetMemberProbes();
  __forgetHeirsForTest();
  // A cluster shared with every team speaks to the oldest one; seeded at the same instant, either was (c44's CI rerun).
  await db
    .update(teams)
    .set({ createdAt: "2026-01-02T00:00:00.000Z" })
    .where(eq(teams.id, TEAM_B));
});

/** Cluster eu on srv_2, srv_3 and srv_4, every pair direct, every agent able to pre-vote, led from a member. */
async function three() {
  const cluster = await eu();
  const { addClusterMember } = await import("./clusters/members");
  await asAdmin(() => addClusterMember(cluster.id, "srv_4"));
  const ids = ["srv_2", "srv_3", "srv_4"];
  for (const id of ids)
    hosts[id].capabilities.push(CLUSTER_SUCCESSION_CAPABILITY);
  __forgetMemberProbes();
  for (const a of ids)
    for (const b of ids)
      if (a !== b)
        await db.insert(clusterNetworkLinks).values({
          clusterId: cluster.id,
          serverId: a,
          peerServerId: b,
          path: "direct",
          checkedAt: nowIso(),
        });
  await placeClusterLeaders();
  return (await getClusterById(cluster.id))!;
}

// c39: the leader restarted with its server's agent, and every member's renewal waited 2.4 s for it.
test("a leader goes to the first in line before its server's agent updates, and Activity says so", async () => {
  const led = await three();
  const from = led.leaderServerId!;
  const [first] = await clusterHeirs(led);
  assert.deepEqual(await handLeadersOff(from), [led.id]);
  const after = await stored(led.id);
  assert.equal(after.server, first);
  assert.ok(after.epoch > led.leaderEpoch, "it leads from the next epoch");
  assert.match(
    (await messages()).join("\n"),
    new RegExp(
      `The leader of cluster eu now runs on ${first}, next in line, while ${from} updates its server agent`,
    ),
  );
});

test("a server that leads nothing hands nothing off", async () => {
  const led = await three();
  const other = ["srv_2", "srv_3", "srv_4"].find(
    (id) => id !== led.leaderServerId,
  )!;
  assert.deepEqual(await handLeadersOff(other), []);
  assert.equal((await stored(led.id)).epoch, led.leaderEpoch);
});
