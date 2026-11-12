import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import type { TestDb } from "../db/test-harness";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { clusterMembers } from "../db/schema/control-plane/clusters";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import type { FakeClusterHost } from "../infra/agent-client/cluster-test-helpers";
import { seedApp, SERVER_1 } from "./app-graph-test-helpers";
import { removeClusterMember } from "./clusters/dissolve";
import { runEmptyingPass } from "./clusters/empty";
import { getClusterLeader } from "./clusters/leader";
import {
  listClusterLeaderChoices,
  moveClusterLeader,
} from "./clusters/leader-move";
import { superviseClusterLeader } from "./clusters/leader-standby";
import { pushLeaderRoster } from "./clusters/leader-sync";
import { createCluster } from "./clusters/manage";
import {
  addClusterMember,
  listClusterJoinCandidates,
  listClusterMembers,
} from "./clusters/members";
import { getClusterById } from "./clusters/roster";
import {
  leaderLab,
  relayRosters,
  type TestLeader,
} from "./cluster-leader-test-helpers";

const lab = leaderLab();
const { asAdmin, asTeamB, eu, messages } = lab;
const everyone = { allTeams: true, teamIds: [] as string[] };
const WARNING =
  "If Deplo's own server stops, its Apps cannot move. Run the leader on another server to fix this.";
// Under three servers a leader elsewhere moves nothing once Deplo's own server is gone: no fix is promised.
const WARNING_SMALL =
  "If Deplo's own server stops, its Apps cannot move. Fixing this takes three servers, with the leader on another one.";
const FP1 = "1".repeat(64);
const FP2 = "2".repeat(64);

let db: TestDb;
let hosts: Record<string, FakeClusterHost>;
let leaders: Record<string, TestLeader>;
beforeEach(() => {
  ({ db, hosts, leaders } = lab);
});

/** An image App that runs on `serverId`, seeded before its server joins a cluster. */
async function runningApp(id: string, serverId: string) {
  await seedApp(db, { id, slug: id, source: "docker-image", serverId });
  await db
    .update(appsTable)
    .set({ name: id, dockerImage: "nginx:1", repoUrl: null, repoRepo: null })
    .where(eq(appsTable.id, id));
  hosts[serverId].stacks[id] = "services:\n  app:\n    image: nginx:1\n";
}

/** Cluster eu of Deplo's own server and srv_2, led from Deplo's own server. */
async function withOwnServer() {
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => addClusterMember(cluster.id, SERVER_1));
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  return cluster;
}

const memberIds = async (clusterId: string) =>
  (await asAdmin(() => listClusterMembers(clusterId))).map((m) => m.serverId);
const warning = async (clusterId: string) =>
  (await asAdmin(() => getClusterLeader(clusterId))).ownServerWarning;

test("Deplo's own server joins like any server: only its Apps become cluster work, beside the leader and relay", async () => {
  await runningApp("web", SERVER_1);
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  const offered = await asAdmin(() => listClusterJoinCandidates(cluster.id));
  assert.deepEqual(offered.find((c) => c.serverId === SERVER_1)?.reasons, []);

  const join = await asAdmin(() => addClusterMember(cluster.id, SERVER_1));
  assert.deepEqual([join.apps, join.databases], [1, 0]);
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  assert.deepEqual(await memberIds(cluster.id), [SERVER_1, "srv_2"]);

  // One certificate, two parties: the leader that runs there and the member it now is.
  assert.deepEqual(relayRosters(hosts[SERVER_1]).at(-1), {
    cluster: cluster.id,
    parties: [
      { fingerprint: FP1, role: "leader" },
      { fingerprint: FP1, role: "member" },
      { fingerprint: FP2, role: "member" },
    ],
  });
  assert.deepEqual(hosts[SERVER_1].memberCalls.at(-1), {
    member: true,
    relays: [],
  });

  await pushLeaderRoster((await getClusterById(cluster.id))!);
  const roster = leaders[SERVER_1].rosters.at(-1)!;
  assert.deepEqual(
    roster.members.map((m) => m.id),
    [SERVER_1, "srv_2"],
  );
  // Deplo itself, its database and its proxy are no rows of the cluster: the leader hears of the App alone.
  assert.deepEqual(
    (roster.placement as { kind: string; id: string; member: string }[]).map(
      (p) => [p.kind, p.id, p.member],
    ),
    [["app", "web", SERVER_1]],
  );
  assert.equal(hosts[SERVER_1].removes, 0);
  assert.equal(hosts[SERVER_1].status.running, true);
});

test("the card warns exactly while Deplo's own server is a member and the leader runs on it", async () => {
  // Not a member, the leader runs there.
  const cluster = await eu();
  assert.equal(await warning(cluster.id), "");

  // Not a member, the leader runs elsewhere.
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  assert.equal(await warning(cluster.id), "");

  // A member, the leader runs elsewhere.
  await asAdmin(() => addClusterMember(cluster.id, SERVER_1));
  assert.equal(await warning(cluster.id), "");

  // A member, and the leader runs there.
  await asAdmin(() => moveClusterLeader(cluster.id, SERVER_1));
  assert.equal(await warning(cluster.id), WARNING);

  // The picker the warning's button opens offers the way out.
  const choices = await asAdmin(() => listClusterLeaderChoices(cluster.id));
  assert.deepEqual(
    choices.filter((c) => !c.current && !c.blocked).map((c) => c.serverId),
    ["srv_2", "srv_3", "srv_4"],
  );
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_2"));
  assert.equal(await warning(cluster.id), "");
});

test("a cluster Deplo's own server is not in never warns, whatever another cluster does", async () => {
  const eu = await withOwnServer();
  const us = await asAdmin(() => createCluster("us", everyone));
  await asAdmin(() => addClusterMember(us.id, "srv_3"));
  assert.equal(await warning(eu.id), WARNING_SMALL);
  assert.equal(await warning(us.id), "");
});

test("no warning while Deplo's own server only stands in for a leader that runs elsewhere", async () => {
  const cluster = await withOwnServer();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  hosts.srv_4.unreachable = true;
  await superviseClusterLeader(cluster.id);
  assert.equal(await superviseClusterLeader(cluster.id), "taken_over");
  const leader = await asAdmin(() => getClusterLeader(cluster.id));
  assert.ok(leader.takenOverAt);
  assert.equal(leader.ownServerWarning, "");
});

test("two servers never read the fix: it only works from three, with the leader on another one", async () => {
  const cluster = await withOwnServer();
  assert.equal(await warning(cluster.id), WARNING_SMALL);
  await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
  assert.equal(await warning(cluster.id), WARNING);
});

const lease = (serverId: string, leaseState: string) =>
  db
    .update(clusterMembers)
    .set({ leaseState })
    .where(eq(clusterMembers.serverId, serverId));

test("the card says whether a failover would work right now", async () => {
  const cluster = await eu();
  await asAdmin(() => addClusterMember(cluster.id, "srv_4"));
  const read = async () => {
    const l = await asAdmin(() => getClusterLeader(cluster.id));
    return [l.state, l.failoverReady, l.message];
  };
  assert.deepEqual(await read(), ["running", true, ""]);

  // One of three silent: the other two still answer, so its work moves.
  await lease("srv_2", "fenced");
  assert.deepEqual(await read(), ["running", true, ""]);

  // Two of three: the leader answers, and moves nothing.
  await lease("srv_3", "not_responding");
  assert.deepEqual(await read(), [
    "running",
    false,
    "Only 1 of 3 servers answers this leader, so nothing moves. Failover works again once 2 do.",
  ]);

  // A leader that does not run keeps its own sentence.
  hosts[SERVER_1].status.running = false;
  assert.deepEqual(await read(), [
    "stopped",
    false,
    "The leader is installed but not running.",
  ]);
});

test("half of an even cluster is enough while Deplo is up, and one server has no failover to speak of", async () => {
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  const ready = async () =>
    (await asAdmin(() => getClusterLeader(cluster.id))).failoverReady;
  assert.equal(await ready(), null);
  await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
  await lease("srv_3", "fenced");
  assert.equal(await ready(), true);
  await lease("srv_2", "fenced");
  assert.equal(await ready(), false);
});

test("only an instance admin reads the leader and its warning, in another team too", async () => {
  const cluster = await withOwnServer();
  await assert.rejects(
    asTeamB(() => getClusterLeader(cluster.id)),
    /instance admin/i,
  );
});

test("emptying Deplo's own server moves its App to another member and leaves the leader and relay running", async () => {
  await runningApp("web", SERVER_1);
  const cluster = await withOwnServer();

  await asAdmin(() => removeClusterMember(cluster.id, SERVER_1));
  assert.equal(
    (await messages()).at(-1),
    `user_1: Started removing server ${SERVER_1} from cluster eu: 1 to move first`,
  );
  await runEmptyingPass();

  const [app] = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "web"));
  assert.equal(app!.serverId, "srv_2");
  assert.equal(app!.clusterId, cluster.id);
  const deploys = await db
    .select({ serverId: deploymentsTable.serverId })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.appId, "web"));
  assert.deepEqual(deploys, [{ serverId: "srv_2" }]);
  // Nothing of Deplo itself was touched: the only stack its agent was asked about is the App's.
  assert.ok(
    hosts[SERVER_1].stack.every((c) => c.endsWith(":web")),
    hosts[SERVER_1].stack.join(", "),
  );
  assert.equal(hosts[SERVER_1].removes, 0);
  assert.equal(hosts[SERVER_1].status.running, true);
  assert.equal(await warning(cluster.id), WARNING_SMALL, "still a member");
});

test("removing Deplo's own server: its agent leaves and the leader keeps running there", async () => {
  await runningApp("web", SERVER_1);
  const cluster = await withOwnServer();
  await assert.rejects(
    asTeamB(() => removeClusterMember(cluster.id, SERVER_1)),
    /instance admin/i,
  );
  assert.deepEqual(await memberIds(cluster.id), [SERVER_1, "srv_2"]);

  await db.delete(appsTable).where(eq(appsTable.id, "web"));
  await asAdmin(() => removeClusterMember(cluster.id, SERVER_1));

  assert.deepEqual(await memberIds(cluster.id), ["srv_2"]);
  assert.deepEqual(hosts[SERVER_1].memberCalls.at(-1), {
    member: false,
    relays: [],
  });
  // It is still the leader's host: the relay lets it through as a leader, and nothing was uninstalled.
  assert.deepEqual(relayRosters(hosts[SERVER_1]).at(-1), {
    cluster: cluster.id,
    parties: [
      { fingerprint: FP1, role: "leader" },
      { fingerprint: FP2, role: "member" },
    ],
  });
  assert.equal(hosts[SERVER_1].removes, 0);
  const leader = await asAdmin(() => getClusterLeader(cluster.id));
  assert.deepEqual(
    [leader.state, leader.onDeploHost, leader.ownServerWarning],
    ["running", true, ""],
  );
  assert.equal(
    (await messages()).at(-1),
    `user_1: Removed server ${SERVER_1} from cluster eu`,
  );
});
