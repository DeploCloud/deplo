import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { SERVER_1 } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { TEAM_B } from "./identity-test-helpers";
import {
  backupDestination as destTable,
  backups as backupsTable,
} from "../db/schema/control-plane/backups";
import { clusters as clustersTable } from "../db/schema/control-plane/clusters";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import {
  FP,
  activity,
  appRow,
  asAdmin,
  asMember,
  asTeamB,
  clusterOf,
  copiesOf,
  db,
  dbRow,
  dissolveHarness,
  everyone,
  hosts,
  memberIds,
  placed,
  placementsOf,
  pushesOf,
  relayRosters,
  runningApp,
  seedClusterState,
  server,
  told,
} from "./cluster-dissolve-test-helpers";
import { reconcileLeftMembers, removeClusterMember } from "./clusters/dissolve";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { pushRostersForServer } from "./clusters/relay";

dissolveHarness();

test("removing an empty member cuts it off at once: no roster names it and its agent is told to leave", async () => {
  await runningApp("web", "srv_2");
  const cluster = await clusterOf("eu", ["srv_2", "srv_3"]);

  await asAdmin(() => removeClusterMember(cluster.id, "srv_3"));

  assert.deepEqual(await memberIds(cluster.id), ["srv_2"]);
  const relay = relayRosters(hosts[SERVER_1]).at(-1);
  assert.deepEqual(relay, {
    cluster: cluster.id,
    parties: [
      { fingerprint: FP[SERVER_1], role: "leader" },
      { fingerprint: FP.srv_2, role: "member" },
    ],
  });
  const roster = told[SERVER_1].rosters.at(-1)!;
  assert.deepEqual(
    roster.members.map((m) => m.id),
    ["srv_2"],
    "the leader's roster no longer names it",
  );
  assert.deepEqual(hosts.srv_3.memberCalls, [{ member: false, relays: [] }]);
  assert.equal((await server("srv_3")).clusterLeavePendingAt, null);
  assert.equal(
    (await activity()).at(-1),
    "user_1: Removed server srv_3 from cluster eu",
  );
  // What stayed on the other member is untouched.
  assert.equal((await appRow("web")).clusterId, cluster.id);
});

test("removing the member that keeps another database's failover backup moves that backup to a member that stays", async () => {
  await seedDatabase(db(), { id: "db_main", name: "main", serverId: "srv_2" });
  const cluster = await clusterOf("eu", ["srv_2", "srv_3", "srv_4"]);
  const destOf = async () => {
    const [b] = await db()
      .select({ serverId: destTable.serverId })
      .from(backupsTable)
      .innerJoin(destTable, eq(destTable.id, backupsTable.destinationId))
      .where(eq(backupsTable.databaseId, "db_main"));
    return b?.serverId;
  };
  assert.equal(await destOf(), "srv_3");

  await asAdmin(() => removeClusterMember(cluster.id, "srv_3"));
  assert.equal(await destOf(), "srv_4");
});

test("only an instance admin removes a member, in the cluster's own team or another", async () => {
  const cluster = await clusterOf("eu", ["srv_2", "srv_3"]);
  for (const as of [asMember, asTeamB])
    await assert.rejects(
      as(() => removeClusterMember(cluster.id, "srv_3")),
      /Only an instance admin can do that/,
    );
  assert.deepEqual(await memberIds(cluster.id), ["srv_2", "srv_3"]);
  assert.deepEqual(hosts.srv_3.memberCalls, [], "its agent heard nothing");
});

test("a member that still runs work is refused until it is emptied, and nothing changes", async () => {
  await runningApp("web", "srv_3");
  await runningApp("api", "srv_3", TEAM_B);
  await seedDatabase(db(), { id: "db_main", name: "main", serverId: "srv_3" });
  const cluster = await clusterOf("eu", ["srv_2", "srv_3"]);

  await assert.rejects(
    asAdmin(() => removeClusterMember(cluster.id, "srv_3")),
    { message: "srv_3 still runs 2 Apps and 1 database. Empty it first." },
  );
  // Keeping them is the last member's choice only.
  await assert.rejects(
    asAdmin(() =>
      removeClusterMember(cluster.id, "srv_3", { keepWorkloads: true }),
    ),
    /Empty it first/,
  );
  assert.deepEqual(await memberIds(cluster.id), ["srv_2", "srv_3"]);
  assert.deepEqual(hosts.srv_3.memberCalls, []);
  assert.equal((await appRow("web")).clusterId, cluster.id);
});

test("a server that is not in the cluster is refused in words", async () => {
  const cluster = await clusterOf("eu", ["srv_2"]);
  await assert.rejects(
    asAdmin(() => removeClusterMember(cluster.id, "srv_4")),
    { message: "srv_4 is not in cluster eu." },
  );
});

test("the last member is refused while it runs work, and says how to keep it", async () => {
  await runningApp("web", "srv_2");
  const cluster = await clusterOf("eu", ["srv_2"]);
  await assert.rejects(
    asAdmin(() => removeClusterMember(cluster.id, "srv_2")),
    {
      message:
        'srv_2 is the last server of eu and still runs 1 App. Choose "Keep its Apps on this server" to remove it.',
    },
  );
  assert.deepEqual(await memberIds(cluster.id), ["srv_2"]);
});

test("the last member keeps its Apps and databases: they stay where they run, as ordinary ones", async () => {
  await runningApp("web", "srv_2");
  await seedDatabase(db(), { id: "db_main", name: "main", serverId: "srv_2" });
  const cluster = await clusterOf("eu", ["srv_2"]);
  await seedClusterState(cluster.id, "web");
  assert.equal((await placementsOf("web")).length, 1);

  await asAdmin(() =>
    removeClusterMember(cluster.id, "srv_2", { keepWorkloads: true }),
  );

  assert.deepEqual(await memberIds(cluster.id), []);
  const web = await appRow("web");
  assert.equal(web.serverId, "srv_2");
  assert.equal(web.clusterId, null);
  const main = await dbRow("db_main");
  assert.equal(main.serverId, "srv_2");
  assert.equal(main.clusterId, null);
  assert.deepEqual(await placementsOf("web"), []);
  assert.deepEqual(await placementsOf("db_main"), []);
  assert.deepEqual(await pushesOf("web"), []);
  assert.deepEqual(await copiesOf("web"), []);
  assert.deepEqual(
    told[SERVER_1].dropped.sort(),
    ["db_main", "web"],
    "the leader dropped both bundles",
  );
  assert.deepEqual(hosts.srv_2.memberCalls, [{ member: false, relays: [] }]);
  assert.deepEqual(hosts.srv_2.stack, [], "nothing was stopped or redeployed");
  assert.deepEqual(told[SERVER_1].rosters.at(-1)!.members, []);
  assert.equal(
    (await activity()).at(-1),
    "user_1: Removed server srv_2 from cluster eu, keeping 1 App and 1 database on it",
  );
  // The cluster itself is still there, empty.
  assert.equal(
    (await db().select().from(clustersTable)).map((c) => c.name).join(),
    "eu",
  );
});

test("a member that does not answer is still removed, and is told it left once it answers", async () => {
  const cluster = await clusterOf("eu", ["srv_2", "srv_3"]);
  hosts.srv_3.unreachable = true;

  await asAdmin(() => removeClusterMember(cluster.id, "srv_3"));
  assert.deepEqual(await memberIds(cluster.id), ["srv_2"]);
  assert.ok(
    !JSON.stringify(relayRosters(hosts[SERVER_1]).at(-1)).includes(FP.srv_3),
    "the relay lets it through no more",
  );
  assert.ok((await server("srv_3")).clusterLeavePendingAt, "still to be told");

  await reconcileLeftMembers();
  assert.ok((await server("srv_3")).clusterLeavePendingAt, "still away");

  hosts.srv_3.unreachable = false;
  await reconcileLeftMembers();
  assert.deepEqual(hosts.srv_3.memberCalls, [{ member: false, relays: [] }]);
  assert.equal((await server("srv_3")).clusterLeavePendingAt, null);
  await reconcileLeftMembers();
  assert.equal(hosts.srv_3.memberCalls.length, 1, "told once");
});

test("a server that joined another cluster before it heard it left forgets the old one, then dials for the new", async () => {
  const eu = await clusterOf("eu", ["srv_2", "srv_3"]);
  hosts.srv_3.unreachable = true;
  await asAdmin(() => removeClusterMember(eu.id, "srv_3"));
  hosts.srv_3.unreachable = false;
  const us = await asAdmin(() => createCluster("us", everyone));
  await asAdmin(() => addClusterMember(us.id, "srv_3"));
  hosts.srv_3.memberCalls.length = 0;

  await reconcileLeftMembers();
  assert.deepEqual(
    hosts.srv_3.memberCalls.map((c) => c.member),
    [false, true],
  );
  assert.deepEqual(await memberIds(us.id), ["srv_3"]);
});

test("the last member is not released while it does not answer: its work would stop a minute later", async () => {
  await runningApp("web", "srv_2");
  const cluster = await clusterOf("eu", ["srv_2"]);
  hosts.srv_2.unreachable = true;
  await assert.rejects(
    asAdmin(() =>
      removeClusterMember(cluster.id, "srv_2", { keepWorkloads: true }),
    ),
    {
      message:
        "srv_2 does not answer, and 1 App still runs on it. Bring it back online, or empty it, before removing it from eu.",
    },
  );
  assert.deepEqual(await memberIds(cluster.id), ["srv_2"]);
  assert.equal((await appRow("web")).clusterId, cluster.id);
});

test("rotating a member's certificate cuts the old one off everywhere at once: the relay, the leader and the other members", async () => {
  const eu = await clusterOf("eu", ["srv_2", "srv_3"]);
  const fresh = "9".repeat(64);
  await db()
    .update(serversTable)
    .set({ agentCertFingerprint: fresh })
    .where(eq(serversTable.id, "srv_3"));

  await pushRostersForServer("srv_3");

  const relay = relayRosters(hosts[SERVER_1]).at(-1);
  assert.equal(relay.cluster, eu.id);
  assert.ok(!JSON.stringify(relay).includes(FP.srv_3));
  assert.ok(JSON.stringify(relay).includes(fresh));
  const roster = told[SERVER_1].rosters.at(-1)!;
  assert.deepEqual(
    roster.members.map((m) => [m.id, m.fingerprint]),
    [
      ["srv_2", FP.srv_2],
      ["srv_3", fresh],
    ],
    "the leader dials it by the new certificate without waiting for its next check",
  );
  assert.deepEqual(hosts.srv_2.forwarders.at(-1)?.members, [
    { serverId: "srv_2", fingerprint: FP.srv_2 },
    { serverId: "srv_3", fingerprint: fresh },
  ]);
});

test("a member that holds only a spread App's other replicas is refused too", async () => {
  await runningApp("web", "srv_2");
  const eu = await clusterOf("eu", ["srv_2", "srv_3"]);
  await placed("web", ["srv_2", "srv_3"]);
  await assert.rejects(
    asAdmin(() => removeClusterMember(eu.id, "srv_3")),
    { message: "srv_3 still runs 1 App. Empty it first." },
  );
  assert.deepEqual(await memberIds(eu.id), ["srv_2", "srv_3"]);
});
