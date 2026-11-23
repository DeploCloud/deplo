import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { RestoreRequest } from "../agent/gen/agent";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { appVolumes } from "../db/schema/control-plane/apps";
import {
  clusterAppReplicas,
  clusters as clustersTable,
} from "../db/schema/control-plane/clusters";
import type { ClusterReplicaReport } from "../infra/agent-client/connection";
import { CLUSTER_REPLICAS_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { seedDeployment } from "./app-graph-test-helpers";
import { pushAppBundle } from "./clusters/app-restore";
import {
  type FailoverStack,
  flushFailoverBundles,
  pushFailoverBundle,
} from "./clusters/bundles";
import { setClusterReplication } from "./clusters/manage";
import {
  AGENT_TOO_OLD,
  __forgetHandedTables,
  __replicationsUnderWay,
  refreshVolumeAppBundles,
  replicateCluster,
} from "./clusters/replication";
import { listClusterReplication } from "./clusters/replica-state";
import { __forgetClusterStandbyTries } from "./databases/standby";
import {
  asAdmin,
  databaseLab,
  db,
  eu,
  host,
  main,
  open,
  web,
} from "./cluster-database-test-helpers";
import { onSrv3, row } from "./cluster-database-standby-test-helpers";

databaseLab();

const STACK: FailoverStack = {
  slug: "web",
  projectId: "prj_web",
  imageRef: "deplo/web:dpl_1",
  composeYaml:
    "services:\n  web:\n    image: deplo/web:dpl_1\n    volumes:\n      - deplo-web-data:/data\n",
  network: "deplo-team-team_a",
  env: {},
  registryAuth: [],
  composeUpArgs: [],
};

/** "web" on srv_2 of a cluster of three that replicates, keeping a Volume, deployed once; every agent can replicate. */
async function replicated(able = ["srv_2", "srv_3", "srv_4"]) {
  __forgetHandedTables();
  __forgetClusterStandbyTries();
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await db
    .update(clustersTable)
    .set({ replicationEnabled: true })
    .where(eq(clustersTable.id, cluster.id));
  await web(cluster.id, "srv_2");
  await db.insert(appVolumes).values({
    appId: "prj_web",
    position: 0,
    volumeId: "vol_web",
    type: "named",
    name: "data",
    hostPath: null,
    mountPath: "/data",
    readOnly: false,
  });
  await seedDeployment(db, { id: "dpl_1", appId: "prj_web", status: "ready" });
  await pushAppBundle({
    appId: "prj_web",
    deploymentId: "dpl_1",
    stack: STACK,
  });
  for (const id of able)
    host[id].capabilities.push(CLUSTER_REPLICAS_CAPABILITY);
  // The first copy the bundle started: each test hands the tables itself.
  await __replicationsUnderWay();
  for (const id of ["srv_2", "srv_3", "srv_4"])
    host[id].replicaTables.length = 0;
  __forgetHandedTables();
  await db.delete(clusterAppReplicas);
  return cluster;
}

const report = (
  over: Partial<ClusterReplicaReport> = {},
): ClusterReplicaReport => ({
  appId: "prj_web",
  role: "receiving",
  connected: true,
  streams: 0,
  synced: true,
  appliedAt: new Date().toISOString(),
  bytes: 4096,
  error: "",
  fromServerId: "srv_2",
  ...over,
});

const said = async () =>
  (await db.select().from(activitiesTable)).map((a) => a.message);

test("every server is handed the cluster's replicated Apps under the names their stacks use", async () => {
  const cluster = await replicated();
  await replicateCluster(cluster.id, true);
  const table = host.srv_3.replicaTables.at(-1)!;
  assert.equal(table.clusterId, cluster.id);
  assert.deepEqual(table.members.map((m) => m.serverId).sort(), [
    "srv_2",
    "srv_3",
    "srv_4",
  ]);
  assert.deepEqual(table.entries, [
    {
      appId: "prj_web",
      slug: "web",
      volumeNames: ["deplo-web-data"],
      includeFiles: false,
    },
  ]);
  assert.deepEqual(
    host.srv_2.replicaTables.at(-1),
    table,
    "the same table everywhere",
  );

  // A table that did not change is not sent again.
  await replicateCluster(cluster.id);
  assert.equal(host.srv_3.replicaTables.length, 1);
});

test("a whole copy on another server makes the App fail over from it, and Activity says so once", async () => {
  const cluster = await replicated();
  await replicateCluster(cluster.id, true);
  await flushFailoverBundles();
  assert.equal(
    (await open("app/prj_web")).restore,
    undefined,
    "no copy yet: it waits",
  );

  host.srv_3.replicaReports = [report()];
  await replicateCluster(cluster.id);
  await flushFailoverBundles();
  const b = await open("app/prj_web");
  assert.equal(b.restore?.backupId, "replica");
  assert.equal(
    b.restore?.storeMember,
    undefined,
    "any server with a whole copy",
  );
  const req = RestoreRequest.fromJSON(b.restore?.request);
  assert.equal(req.fromReplica, true);
  assert.deepEqual(req.project?.volumeNames, ["deplo-web-data"]);
  assert.equal(req.project?.slug, "web");

  await replicateCluster(cluster.id);
  assert.deepEqual(
    (await said()).filter((m) => m.startsWith("web: Copies")),
    ["web: Copies: 1 of 2 up to date. It can move if server-2 goes off."],
  );
});

test("the cluster page reads how many servers follow, and why one does not", async () => {
  const cluster = await replicated();
  host.srv_3.replicaReports = [report()];
  host.srv_4.replicaReports = [
    report({
      connected: false,
      synced: false,
      error: "the server the App runs on refused",
    }),
  ];
  await replicateCluster(cluster.id, true);
  const [state] = await asAdmin(() => listClusterReplication(cluster.id));
  assert.equal(state.appName, "web");
  assert.equal(state.following, 1);
  assert.equal(state.held, 1);
  assert.equal(state.total, 2);
  assert.ok(state.upToDateAt);
  assert.equal(state.error, "the server the App runs on refused");
});

test("a server whose agent cannot replicate is named, and the others carry on", async () => {
  const cluster = await replicated(["srv_2", "srv_3"]);
  host.srv_3.replicaReports = [report()];
  await replicateCluster(cluster.id, true);
  assert.equal(host.srv_4.replicaTables.length, 0);
  const rows = await db
    .select()
    .from(clusterAppReplicas)
    .where(eq(clusterAppReplicas.serverId, "srv_4"));
  assert.equal(rows[0]?.error, AGENT_TOO_OLD);
  await flushFailoverBundles();
  assert.equal((await open("app/prj_web")).restore?.backupId, "replica");
});

test("replication off hands every server an empty table, the App waits again and no status stays", async () => {
  const cluster = await replicated();
  host.srv_3.replicaReports = [report()];
  await replicateCluster(cluster.id, true);

  await asAdmin(() => setClusterReplication(cluster.id, false));
  await replicateCluster(cluster.id, true);
  await refreshVolumeAppBundles(cluster.id);
  await flushFailoverBundles();
  assert.deepEqual(host.srv_3.replicaTables.at(-1)?.entries, []);
  assert.equal((await open("app/prj_web")).restore, undefined);
  assert.equal((await db.select().from(clusterAppReplicas)).length, 0);
});

test("a database on a cluster that replicates gets its standby copy from Deplo, and loses it with replication", async () => {
  const cluster = await replicated();
  await main(cluster.id);
  onSrv3();
  await replicateCluster(cluster.id, true);
  let db0 = await row();
  assert.equal(db0.standby, true);
  assert.equal(db0.standbyFromCluster, true);
  assert.ok(
    (await said()).includes(
      "Keeps a standby copy of main on server-3: cluster eu replicates its databases",
    ),
  );

  await db
    .update(clustersTable)
    .set({ replicationEnabled: false })
    .where(eq(clustersTable.id, cluster.id));
  await replicateCluster(cluster.id, true);
  db0 = await row();
  assert.equal(db0.standby, false);
  assert.equal(db0.standbyFromCluster, false);
});

test("a standby copy a person turned on stays when replication goes", async () => {
  const cluster = await replicated();
  await main(cluster.id);
  onSrv3();
  await db
    .update(clustersTable)
    .set({ replicationEnabled: false })
    .where(eq(clustersTable.id, cluster.id));
  const { setDatabaseStandby } = await import("./databases/standby");
  await asAdmin(() => setDatabaseStandby("db_main", true));
  await replicateCluster(cluster.id, true);
  const db0 = await row();
  assert.equal(db0.standby, true);
  assert.equal(db0.standbyFromCluster, false);
});

test("an App's first copy starts the moment its bundle is stored, not on the watch's next pass", async () => {
  const cluster = await replicated();
  await __replicationsUnderWay();
  for (const id of ["srv_2", "srv_3", "srv_4"])
    host[id].replicaTables.length = 0;
  __forgetHandedTables();
  await pushAppBundle({
    appId: "prj_web",
    deploymentId: "dpl_1",
    stack: STACK,
  });
  await __replicationsUnderWay();
  assert.deepEqual(
    host.srv_3.replicaTables.at(-1)?.entries.map((e) => e.appId),
    ["prj_web"],
  );
  assert.equal(host.srv_3.replicaTables.at(-1)?.clusterId, cluster.id);
});

// eu, 23 Nov 2026: memos' bundle was pushed while no copy was whole and never sent again, since its copies became
// whole between two passes: a failover waited for its server for 3 minutes. Each pass puts the bundle in step.
test("a bundle stored without its whole copy is sent again with it, though no copy changed", async () => {
  const cluster = await replicated();
  host.srv_3.replicaReports = [report()];
  await replicateCluster(cluster.id, true);
  await flushFailoverBundles();
  assert.equal((await open("app/prj_web")).restore?.backupId, "replica");
  await pushFailoverBundle({
    appId: "prj_web",
    deploymentId: "dpl_1",
    stack: STACK,
  });
  await flushFailoverBundles();
  assert.equal((await open("app/prj_web")).restore, undefined);
  await replicateCluster(cluster.id);
  await flushFailoverBundles();
  assert.equal((await open("app/prj_web")).restore?.backupId, "replica");
});
