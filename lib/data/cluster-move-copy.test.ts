import { after, test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  clusterMembers,
  clusters as clustersTable,
  failoverBundlePushes,
} from "../db/schema/control-plane/clusters";
import { encryptSecret } from "../crypto";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { serverAgentCapabilities } from "../db/schema/control-plane/servers";
import { __setRunnerForTest } from "../deploy/deploy-queue";
import { nowIso } from "../ids";
import type {
  AgentConnection,
  ClusterReplicaReport,
} from "../infra/agent-client/connection";
import {
  CLUSTER_REPLICAS_CAPABILITY,
  CLUSTER_REPLICAS_MOVE_CAPABILITY,
  NEWEST_WINS_CAPABILITY,
  VOLUME_COPY_MEMBER_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import { seedDeployment } from "./app-graph-test-helpers";
import { __forgetMoveTries, moveClusterDataBeforeStart } from "./app-migration";
import { moveAppToCluster } from "./apps/source";
import type { FailoverBundle } from "./clusters/bundles";
import { __forgetTurns } from "./clusters/copy-turns";
import { copyAheadWait } from "./clusters/move-copy";
import { __forgetMoves } from "./clusters/moves";
import { listWorkloadPlacements } from "./clusters/placement";
import { replicateCluster } from "./clusters/replication";
import {
  activity,
  appRow,
  asAdmin,
  db,
  disks,
  emptyLab,
  eu,
  hosts,
  pg,
  runningApp,
  tarWith,
} from "./cluster-empty-test-helpers";

// c44: a move stopped lab-kit-d, then copied all 64 MB again though eu-3's copy was current (13.5 s down).

emptyLab();
after(() => {
  __forgetTurns();
  __forgetMoves();
  __forgetMoveTries();
});

const VOL = "deplo-fise-data";
const YAML = `services:\n  app:\n    image: nginx:1\n    volumes:\n      - ${VOL}:/data\nvolumes:\n  ${VOL}:\n    name: ${VOL}\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fise on srv_2 of a cluster that replicates, deployed there once; both members' agents hand a copy over on a move. */
async function fiseOnCluster() {
  __forgetTurns();
  await runningApp("fise", "srv_2");
  await pg.exec(
    `insert into app_volumes (volume_id, app_id, position, type, name, mount_path, read_only)
       values ('vol_1', 'fise', 0, 'named', 'data', '/data', false)`,
  );
  const old = disks.get("srv_2")!;
  old.stacks.set("fise", YAML);
  old.volumes.set(VOL, tarWith("data/rows", "rows 1-142"));
  old.ran.set("fise", { lastRanMs: Date.now() - 2_000, running: true });
  const cluster = await eu();
  await db
    .update(clustersTable)
    .set({ replicationEnabled: true })
    .where(eq(clustersTable.id, cluster.id));
  await db
    .update(appsTable)
    .set({ clusterId: cluster.id })
    .where(eq(appsTable.id, "fise"));
  for (const id of ["srv_2", "srv_3"]) {
    hosts
      .get(id)!
      .capabilities.push(
        VOLUME_COPY_MEMBER_CAPABILITY,
        NEWEST_WINS_CAPABILITY,
        CLUSTER_REPLICAS_CAPABILITY,
      );
    await db
      .insert(serverAgentCapabilities)
      .values({
        serverId: id,
        capability: CLUSTER_REPLICAS_MOVE_CAPABILITY,
        agentVersion: "0.5.3",
        reportedAt: nowIso(),
      })
      .onConflictDoNothing();
  }
  await seedDeployment(db, { id: "dpl_1", appId: "fise", status: "ready" });
  // The bundle as its leader holds it: this lab has no leader key to seal one to.
  const bundle: FailoverBundle = {
    v: 1,
    kind: "app",
    workload: "fise",
    deploymentId: "dpl_1",
    stack: {
      slug: "fise",
      projectId: "fise",
      imageRef: "nginx:1",
      composeYaml: YAML,
      network: "deplo-team-team_a",
      env: {},
      registryAuth: [],
      composeUpArgs: [],
    },
  };
  await db.delete(failoverBundlePushes);
  await db.insert(failoverBundlePushes).values({
    workloadKind: "app",
    workloadId: "fise",
    keyFingerprint: "a".repeat(64),
    deploymentId: "dpl_1",
    bundleEnc: encryptSecret(JSON.stringify(bundle)),
  });
  __setRunnerForTest(async (depId) => {
    await db
      .update(deploymentsTable)
      .set({ status: "canceled" })
      .where(eq(deploymentsTable.id, depId));
  });
  return cluster;
}

/** How srv_3's copy of fise stands, as its agent says. */
function copyOnSrv3(over: Partial<ClusterReplicaReport> = {}) {
  hosts.get("srv_3")!.replicaReports = [
    {
      appId: "fise",
      role: "receiving",
      connected: true,
      streams: 0,
      synced: true,
      appliedAt: new Date().toISOString(),
      bytes: 4096,
      error: "",
      fromServerId: "srv_2",
      ...over,
    },
  ];
}

test("a move onto a member whose copy follows takes only the last changes, never the whole data", async () => {
  const cluster = await fiseOnCluster();
  copyOnSrv3();
  await replicateCluster(cluster.id);
  await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
  assert.equal((await appRow("fise")).serverId, "srv_3");
  const lines: string[] = [];
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", (_l, t) =>
      lines.push(t),
    ),
    "done",
    lines.join("\n"),
  );
  assert.deepEqual(hosts.get("srv_3")!.promotions, [
    { appId: "fise", from: "srv_2" },
  ]);
  assert.ok(
    !disks.get("srv_3")!.calls.includes(`member-import:${VOL}`),
    "its data was not copied whole",
  );
  assert.ok(
    (await activity()).some((m) => /its last changes only \(/.test(m)),
    (await activity()).join("\n"),
  );
});

// c48: lab-kit-a and -b were down 17.2 s each, stopped by the leader's placement before their starts had a turn.
test("a move places its App on its new member only once its start runs, so it keeps running while it waits", async () => {
  const cluster = await fiseOnCluster();
  copyOnSrv3();
  await replicateCluster(cluster.id);
  const placedOn = async () =>
    ((await listWorkloadPlacements("app", ["fise"])).get("fise") ?? []).map(
      (p) => p.serverId,
    );
  await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
  assert.equal((await appRow("fise")).serverId, "srv_3");
  assert.ok(!(await placedOn()).includes("srv_3"), "not placed while queued");
  assert.ok(!disks.get("srv_2")!.calls.includes("stop:fise"));
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", () => {}),
    "done",
  );
  assert.deepEqual(await placedOn(), ["srv_3"]);
});

// c46: twice a pass came between the leader placing lab-kit-d and its stop, and the whole volume was copied.
test("a pass after the leader placed it on its new member still takes only the last changes", async () => {
  const cluster = await fiseOnCluster();
  copyOnSrv3();
  await replicateCluster(cluster.id);
  await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
  copyOnSrv3({ role: "sending", synced: false, appliedAt: "" });
  await replicateCluster(cluster.id);
  const lines: string[] = [];
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", (_l, t) =>
      lines.push(t),
    ),
    "done",
    lines.join("\n"),
  );
  assert.deepEqual(hosts.get("srv_3")!.promotions, [
    { appId: "fise", from: "srv_2" },
  ]);
  assert.ok(!disks.get("srv_3")!.calls.includes(`member-import:${VOL}`));
});

test("a move that copies the data whole says why on Activity", async () => {
  const cluster = await fiseOnCluster();
  copyOnSrv3();
  await replicateCluster(cluster.id);
  await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
  (
    hosts.get("srv_3")!.extra as Partial<AgentConnection>
  ).promoteClusterReplica = async () => {
    throw new Error("this server has no whole copy of the App's data yet");
  };
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", () => {}),
    "done",
  );
  assert.ok(
    (await activity()).some((m) =>
      /Moved fise's data from srv_2 to srv_3, .*\. All of it was copied: its copy on srv_3 could not take its last changes \(this server has no whole copy/.test(
        m,
      ),
    ),
    (await activity()).join("\n"),
  );
});

test("a move waits, its App running, until its new member's copy follows, then goes", async () => {
  copyAheadWait.everyMs = 5;
  try {
    const cluster = await fiseOnCluster();
    copyOnSrv3({ synced: false });
    await replicateCluster(cluster.id);
    await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
    assert.equal((await appRow("fise")).serverId, "srv_2", "it runs there");
    assert.ok(!disks.get("srv_2")!.calls.includes("stop:fise"));
    // c49: a move waited 2 minutes for its copy, and 15 on a dead one, with nothing on Activity.
    const waits = "Deplo: Moving fise waits for its copy on srv_3.";
    const failed =
      "Deplo: Moving fise still waits: its copy on srv_3 failed (endpoint is closed for send). Deplo makes it again.";
    const count = async (m: string) =>
      (await activity()).filter((a) => a === m).length;
    for (let i = 0; i < 200 && !(await count(waits)); i++) await sleep(10);
    copyOnSrv3({
      synced: false,
      connected: false,
      error: "endpoint is closed for send",
    });
    for (let i = 0; i < 200 && !(await count(failed)); i++) await sleep(10);
    await sleep(50);
    assert.equal(await count(waits), 1, "said once");
    assert.equal(await count(failed), 1, "said once");
    copyOnSrv3();
    for (let i = 0; i < 400; i++) {
      if ((await appRow("fise")).serverId === "srv_3") break;
      await sleep(10);
    }
    assert.equal((await appRow("fise")).serverId, "srv_3");
  } finally {
    copyAheadWait.everyMs = 2_000;
  }
});

// c47: lab-kit-a's move towards eu-4 waited on its copy for 24 minutes after eu-4 was removed.
test("a move whose new member leaves the cluster fails at once and says why, its App where it runs", async () => {
  copyAheadWait.everyMs = 5;
  try {
    const cluster = await fiseOnCluster();
    copyOnSrv3({ synced: false });
    await replicateCluster(cluster.id);
    await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
    await db.delete(clusterMembers).where(eq(clusterMembers.serverId, "srv_3"));
    const why = `Moving fise did not start: srv_3 left cluster ${cluster.name}, so fise stays on srv_2.`;
    const said = async () => (await activity()).some((m) => m.endsWith(why));
    for (let i = 0; i < 200 && !(await said()); i++) await sleep(10);
    assert.ok(await said(), (await activity()).join("\n"));
    const app = await appRow("fise");
    assert.equal(app.serverId, "srv_2");
    assert.equal(app.migrateFromServerId, null);
    assert.ok(!disks.get("srv_2")!.calls.includes("stop:fise"));
  } finally {
    copyAheadWait.everyMs = 2_000;
  }
});

// c44: a move to eu-1 at its disk floor read "broke when a link dropped", went 4 times and moved its backups 6 times.
test("a move whose copy does not fit there is refused with both sizes, before anything changes", async () => {
  const cluster = await fiseOnCluster();
  copyOnSrv3({
    role: "idle",
    connected: false,
    synced: false,
    error:
      "srv_3 has 1.8 GB free, too little to go on with this copy and keep a tenth of its disk free",
  });
  await replicateCluster(cluster.id);
  await assert.rejects(
    asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3")),
    /free, too little .* tenth of its disk free, so fise stays on srv_2\.$/,
  );
  const app = await appRow("fise");
  assert.equal(app.serverId, "srv_2");
  assert.equal(app.migrateFromServerId, null);
  assert.ok(!disks.get("srv_2")!.calls.includes("stop:fise"));
  assert.ok(
    !(await activity()).some((m) => /Moved|from now on/.test(m)),
    (await activity()).join("\n"),
  );
});

test("a copy its new member stopped for room is refused for room, never tried again as a dropped link", async () => {
  __forgetMoveTries();
  const cluster = await fiseOnCluster();
  await db
    .delete(serverAgentCapabilities)
    .where(
      eq(serverAgentCapabilities.capability, CLUSTER_REPLICAS_MOVE_CAPABILITY),
    );
  await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
  (hosts.get("srv_2")!.extra as Partial<AgentConnection>).sendClusterVolume =
    async () => {
      throw new Error(`send volume "${VOL}": write: broken pipe`);
    };
  (hosts.get("srv_3")!.extra as Partial<AgentConnection>).metrics =
    (async () => ({
      diskTotal: 100e9,
      diskUsed: 95e9,
      diskPct: 95,
    })) as unknown as AgentConnection["metrics"];
  const lines: string[] = [];
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", (_l, t) =>
      lines.push(t),
    ),
    "rolled-back",
  );
  assert.match(
    lines.join("\n"),
    /srv_3 has .* free, too little for a copy of fise \(about .*\) and a tenth of its disk free/,
  );
  assert.doesNotMatch(lines.join("\n"), /link dropped|goes again/);
  await sleep(50);
  assert.equal((await appRow("fise")).serverId, "srv_2");
  assert.equal((await appRow("fise")).migrateFromServerId, null);
});

test("a stopped App moves at once: nothing sends its changes, so no copy is waited for", async () => {
  const cluster = await fiseOnCluster();
  await db
    .update(appsTable)
    .set({ status: "idle" })
    .where(eq(appsTable.id, "fise"));
  copyOnSrv3({ role: "idle", connected: false, appliedAt: "" });
  await replicateCluster(cluster.id);
  await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
  assert.equal((await appRow("fise")).serverId, "srv_3");
});
