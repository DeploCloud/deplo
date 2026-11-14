import { test } from "node:test";
import assert from "node:assert/strict";

import { seedApp } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { createCluster } from "./clusters/manage";
import { settleProvisioningMembers } from "./clusters/member-ready";
import {
  addClusterMember,
  listClusterJoinCandidates,
  listClusterMembers,
} from "./clusters/members";
import { getClusterById } from "./clusters/roster";
import { failoverLab } from "./cluster-failover-test-helpers";

const lab = failoverLab();
const { asAdmin } = lab;

const leaderSays = (clusterId: string, states: Record<string, string>) => {
  lab.snapshot = {
    head: 0,
    clusters: {
      [clusterId]: {
        epoch: 1,
        superseded: false,
        members: Object.entries(states).map(([id, state]) => ({ id, state })),
      },
    },
  };
};

const provisioning = async (clusterId: string) =>
  Object.fromEntries(
    (await asAdmin(() => listClusterMembers(clusterId))).map((m) => [
      m.serverId,
      m.provisioning,
    ]),
  );

test("a server that joins reads Provisioning until the cluster's leader answers for it", async () => {
  const cluster = await lab.eu();
  const c = (await getClusterById(cluster.id))!;
  assert.deepEqual(await provisioning(cluster.id), {
    srv_2: true,
    srv_3: true,
  });

  // The leader has not heard of the cluster yet.
  assert.equal(await settleProvisioningMembers(c), 0);
  assert.deepEqual(await provisioning(cluster.id), {
    srv_2: true,
    srv_3: true,
  });

  leaderSays(cluster.id, { srv_2: "ok", srv_3: "not_responding" });
  assert.equal(await settleProvisioningMembers(c), 1);
  assert.deepEqual(await provisioning(cluster.id), {
    srv_2: false,
    srv_3: true,
  });

  leaderSays(cluster.id, { srv_2: "fenced", srv_3: "ok" });
  assert.equal(await settleProvisioningMembers(c), 1);
  assert.deepEqual(
    await provisioning(cluster.id),
    { srv_2: false, srv_3: false },
    "a server that worked once never goes back to Provisioning",
  );
});

test("the leader is not asked when no server is joining", async () => {
  const cluster = await lab.eu();
  const c = (await getClusterById(cluster.id))!;
  leaderSays(cluster.id, { srv_2: "ok", srv_3: "ok" });
  assert.equal(await settleProvisioningMembers(c), 2);
  lab.calls.length = 0;
  assert.equal(await settleProvisioningMembers(c), 0);
  assert.equal(
    lab.calls.filter((x) => x.method === "leader.snapshot").length,
    0,
  );
});

test("the join picker says how many Apps and databases join with each server", async () => {
  const cluster = await asAdmin(() =>
    createCluster("eu", { allTeams: true, teamIds: [] }),
  );
  await seedApp(lab.db, { id: "prj_web", slug: "web", serverId: "srv_2" });
  await seedApp(lab.db, { id: "prj_api", slug: "api", serverId: "srv_2" });
  await seedDatabase(lab.db, { id: "db_main", serverId: "srv_2" });
  const counts = Object.fromEntries(
    (await asAdmin(() => listClusterJoinCandidates(cluster.id))).map((c) => [
      c.serverId,
      [c.apps, c.databases],
    ]),
  );
  assert.deepEqual(counts.srv_2, [2, 1]);
  assert.deepEqual(counts.srv_3, [0, 0]);

  const join = await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
  assert.equal(join.member.provisioning, true);
});
