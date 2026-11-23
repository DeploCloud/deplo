import { test, after } from "node:test";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";

import { activities } from "../db/schema/control-plane/activity";
import { appVolumes } from "../db/schema/control-plane/apps";
import {
  clusterAppReplicas,
  clusterMembers,
  clusterWarnings,
  clusters as clustersTable,
} from "../db/schema/control-plane/clusters";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { doorClosed, doorOpened } from "../infra/agent-link/registry";
import { LINK_SETTLE_MS } from "../infra/agent-link/protocol";
import { OUT_OF_REACH } from "../apps/display-status";
import { sayCannotFailOver } from "./clusters/bundles";
import { appMoveState } from "./clusters/moves";
import {
  clusterOutOfReach,
  outOfReachFailure,
  sinceClock,
} from "./clusters/reach";
import { replicateCluster } from "./clusters/replication";
import { listClusterReplication } from "./clusters/replica-state";
import { refreshClusterWarnings } from "./clusters/warnings";
import { applyLeaderEvent } from "./clusters/watch";
import { getClusterById } from "./clusters/roster";
import { TEAM_A } from "./identity-test-helpers";
import {
  asAdmin,
  db,
  diskOps,
  disks,
  emptyLab,
  eu,
  fleet,
  runningApp,
} from "./cluster-empty-test-helpers";

emptyLab();
after(() => doorClosed());

const lastSeen = (id: string, at: string) =>
  db
    .update(serversTable)
    .set({ lastSeenAt: at })
    .where(eq(serversTable.id, id));

const said = async () =>
  (
    await db
      .select({ message: activities.message, at: activities.createdAt })
      .from(activities)
      .orderBy(activities.seq)
  ).map((a) => ({ message: a.message, at: new Date(a.at).toISOString() }));

test("while no server of a cluster answers, Deplo says since when and keeps what it last knew", async () => {
  await runningApp("web", "srv_2");
  const cluster = (await getClusterById((await eu()).id))!;
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  await lastSeen("srv_2", new Date(Date.now() - 6 * 60_000).toISOString());
  await lastSeen("srv_3", since);
  await db.insert(clusterWarnings).values({
    clusterId: cluster.id,
    key: "leader",
    position: 0,
    title: "Failover is not working right now",
    body: "Checked before Deplo lost the cluster.",
    checkedAt: since,
  });
  // The door has been open long enough that a server never heard is one that does not answer.
  doorOpened(Date.now() - LINK_SETTLE_MS - 1000);
  const setup = (await said()).length;
  try {
    assert.equal(await clusterOutOfReach(cluster.id), since);

    await refreshClusterWarnings(cluster);
    await refreshClusterWarnings(cluster);
    const banners = await db
      .select({ key: clusterWarnings.key, title: clusterWarnings.title })
      .from(clusterWarnings)
      .where(eq(clusterWarnings.clusterId, cluster.id))
      .orderBy(clusterWarnings.position);
    assert.deepEqual(banners, [
      {
        key: "out_of_reach",
        title: `Deplo cannot reach this cluster since ${sinceClock(since)}: its servers decide on their own`,
      },
      { key: "leader", title: "Failover is not working right now" },
    ]);
    // Said once, at the time Deplo last heard the cluster.
    assert.deepEqual((await said()).slice(setup), [
      {
        message: `Deplo cannot reach cluster eu since ${sinceClock(since)}: its servers decide on their own. What Deplo shows of it is how it stood then.`,
        at: since,
      },
    ]);

    // What a leader standing in reports of its servers, and what it lacks, are guesses: neither is said.
    await applyLeaderEvent(cluster.id, {
      seq: cluster.eventSeq + 1,
      type: "member_state",
      cluster: cluster.id,
      data: { member: "srv_2", state: "fenced" },
    });
    const [m] = await db
      .select({ state: clusterMembers.leaseState })
      .from(clusterMembers)
      .where(
        and(
          eq(clusterMembers.clusterId, cluster.id),
          eq(clusterMembers.serverId, "srv_2"),
        ),
      );
    assert.equal(m?.state, "ok");
    await sayCannotFailOver(
      { id: "web", name: "web", teamId: TEAM_A },
      cluster,
      "the cluster's leader did not take its bundle.",
    );
    assert.equal((await said()).length, setup + 1);

    // How each copy stood is kept as Deplo last heard it.
    await db.insert(clusterAppReplicas).values({
      appId: "web",
      serverId: "srv_3",
      role: "receiving",
      connected: true,
      synced: true,
      appliedAt: since,
      checkedAt: since,
    });
    await replicateCluster(cluster.id);
    // Nor does the cluster's banner call a copy behind because Deplo stopped hearing it.
    await db.insert(appVolumes).values({
      appId: "web",
      position: 0,
      volumeId: "vol_web_data",
      type: "volume",
      name: "data",
      mountPath: "/data",
      readOnly: false,
    });
    await db
      .update(clustersTable)
      .set({ replicationEnabled: true })
      .where(eq(clustersTable.id, cluster.id));
    await db
      .update(clusterAppReplicas)
      .set({ appliedAt: new Date(Date.parse(since) - 2_000).toISOString() });
    assert.deepEqual(
      (await asAdmin(() => listClusterReplication(cluster.id))).map((r) => [
        r.appName,
        r.following,
        r.total,
      ]),
      [["web", 1, 1]],
    );
    await db.update(clusterAppReplicas).set({ appliedAt: since });
    assert.deepEqual(
      (await db.select().from(clusterAppReplicas)).map((r) => [
        r.serverId,
        new Date(r.checkedAt).toISOString(),
      ]),
      [["srv_3", since]],
    );

    const state = await appMoveState(
      {
        id: "web",
        serverId: "srv_2",
        clusterId: cluster.id,
        volumes: [],
        mounts: [],
        compose: null,
      },
      true,
    );
    assert.equal(
      state.offlineWhy,
      `${OUT_OF_REACH} since ${sinceClock(since)}`,
    );
  } finally {
    doorClosed();
  }

  // Heard again: the banner goes, and Activity says so.
  await refreshClusterWarnings(cluster);
  assert.equal(
    (
      await db
        .select()
        .from(clusterWarnings)
        .where(eq(clusterWarnings.key, "out_of_reach"))
    ).length,
    0,
  );
  assert.equal(
    (await said()).at(-1)?.message,
    "Deplo reaches cluster eu again",
  );
});

test("a copies pass that began before the silence records nothing once it falls", async () => {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await db.insert(clusterAppReplicas).values({
    appId: "web",
    serverId: "srv_3",
    role: "receiving",
    connected: true,
    synced: true,
    appliedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
  });
  for (const id of ["srv_2", "srv_3"])
    await lastSeen(id, new Date(Date.now() - 60_000).toISOString());
  // Every server stops answering while the pass is asking the first one.
  fleet.host("srv_2", {
    extra: {
      ...diskOps(disks.get("srv_2")!),
      hello: async () => {
        doorOpened(Date.now() - LINK_SETTLE_MS - 1000);
        throw new Error("the server is offline");
      },
    },
  });
  try {
    await replicateCluster(cluster.id);
  } finally {
    doorClosed();
  }
  assert.equal((await db.select().from(clusterAppReplicas)).length, 1);
});

test("a Deplo whose door just opened cannot tell yet, so no cluster is out of reach", async () => {
  const cluster = await eu();
  doorOpened(Date.now());
  try {
    assert.equal(await clusterOutOfReach(cluster.id), null);
  } finally {
    doorClosed();
  }
});

test("the time reads as a clock today and with its date before", () => {
  const now = Date.parse("2026-11-23T09:00:00Z");
  assert.equal(sinceClock("2026-11-23T05:32:10.000Z", now), "05:32 UTC");
  assert.equal(
    sinceClock("2026-11-22T23:59:00.000Z", now),
    "2026-11-22 at 23:59 UTC",
  );
});

test("a backup Deplo could not take while it reaches no server of the cluster says so, not that a server is off", async () => {
  await runningApp("web", "srv_2");
  const cluster = (await getClusterById((await eu()).id))!;
  const since = new Date(Date.now() - 4 * 60_000).toISOString();
  await lastSeen("srv_2", since);
  await lastSeen("srv_3", since);
  doorOpened(Date.now() - LINK_SETTLE_MS - 1000);
  try {
    assert.equal(
      await outOfReachFailure("srv_2", "take this backup"),
      `Deplo cannot reach cluster ${cluster.name} since ${sinceClock(since)}, so it could not take this backup: its servers keep running without Deplo`,
    );
    // A server of no cluster is simply offline.
    assert.equal(await outOfReachFailure("srv_4", "take this backup"), null);
  } finally {
    doorClosed();
  }
});
