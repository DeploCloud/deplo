import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { RestoreRequest } from "../agent/gen/agent";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { appVolumes } from "../db/schema/control-plane/apps";
import {
  backupDestination,
  backupRuns,
} from "../db/schema/control-plane/backups";
import {
  clusterAppReplicas,
  clusters as clustersTable,
} from "../db/schema/control-plane/clusters";
import type { ClusterReplicaReport } from "../infra/agent-client/connection";
import {
  CLUSTER_REPLICAS_CAPABILITY,
  VOLUME_USAGE_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import type { HostMetrics } from "../agent/gen/agent";
import { listClusterMembers } from "./clusters/members";
import { seedDeployment } from "./app-graph-test-helpers";
import { pushAppBundle, refreshAppBundle } from "./clusters/app-restore";
import {
  type FailoverStack,
  flushFailoverBundles,
  inBackground,
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
import { following, listClusterReplication } from "./clusters/replica-state";
import {
  __forgetTurns,
  holdTurn,
  takeTurn,
  turnWait,
} from "./clusters/copy-turns";
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
  // Each test's copies ask anew: the turns and the line of the one before are not theirs.
  __forgetTurns();
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
      hold: "",
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

// eu, 24 Nov 2026: a refresh by replication read lab-web's bundle while a domain's refresh was on its way, then sent it
// last: the App moved without its routes and answered 404 for 5 minutes. Every refresh waits its turn, then reads.
test("a refresh by replication waits for a push under way, and keeps what that push changed", async () => {
  const cluster = await replicated();
  await replicateCluster(cluster.id, true);
  await flushFailoverBundles();
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  inBackground("prj_web", async () => {
    await gate;
    await refreshAppBundle("prj_web", (s) => ({
      ...s,
      composeYaml: s.composeYaml + "# routed\n",
    }));
  });
  host.srv_3.replicaReports = [report()];
  let done = false;
  const pass = replicateCluster(cluster.id).then(() => (done = true));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(done, false, "the pass waits for the push under way");
  release();
  await pass;
  await flushFailoverBundles();
  const b = await open("app/prj_web");
  assert.equal(b.restore?.backupId, "replica");
  assert.match(b.stack.composeYaml, /# routed/);
});

const disk = (total: number, used: number) =>
  (async () => ({
    diskTotal: total,
    diskUsed: used,
  })) as unknown as () => Promise<HostMetrics>;

// ADR-0043, eu-1 at 99%: a member back with its dated copy took a whole new replica beside it.
test("a copy that would leave less than a tenth of a server's disk does not start, and the server says why", async () => {
  const cluster = await replicated();
  const GB = 1024 ** 3;
  host.srv_2.capabilities.push(VOLUME_USAGE_CAPABILITY);
  host.srv_2.extra.volumeUsage = async () =>
    new Map([["deplo-web-data", 2 * GB]]);
  host.srv_3.extra.metrics = disk(14 * GB, 12 * GB);
  host.srv_4.extra.metrics = disk(14 * GB, 5 * GB);
  await replicateCluster(cluster.id, true);
  assert.deepEqual(
    host.srv_3.replicaTables.at(-1)!.entries,
    [],
    "srv_3 starts no copy",
  );
  assert.equal(host.srv_4.replicaTables.at(-1)!.entries.length, 1);
  const [why] = await db
    .select({ error: clusterAppReplicas.error })
    .from(clusterAppReplicas)
    .where(eq(clusterAppReplicas.serverId, "srv_3"));
  assert.equal(
    why.error,
    "server-3 has 2.0 GB free, too little for a copy of web (about 2.0 GB) and a tenth of its disk free",
  );
  const members = await asAdmin(() => listClusterMembers(cluster.id));
  assert.match(
    members.find((m) => m.serverId === "srv_3")!.copyWarning,
    /too little for a copy of web \(about 2\.0 GB\).*Free some space on it/,
  );
  assert.equal(members.find((m) => m.serverId === "srv_4")!.copyWarning, "");

  // Room again: the copy starts, and the warning goes.
  host.srv_3.extra.metrics = disk(14 * GB, 4 * GB);
  host.srv_3.replicaReports = [report({ synced: false, bytes: 0 })];
  await replicateCluster(cluster.id, true);
  assert.equal(host.srv_3.replicaTables.at(-1)!.entries.length, 1);
  const after = await asAdmin(() => listClusterMembers(cluster.id));
  assert.equal(after.find((m) => m.serverId === "srv_3")!.copyWarning, "");
});

test("a copy a server already holds whole is never held back for room", async () => {
  const cluster = await replicated();
  const GB = 1024 ** 3;
  host.srv_2.capabilities.push(VOLUME_USAGE_CAPABILITY);
  host.srv_2.extra.volumeUsage = async () =>
    new Map([["deplo-web-data", 2 * GB]]);
  host.srv_3.extra.metrics = disk(14 * GB, 13 * GB);
  host.srv_3.replicaReports = [report({ bytes: 2 * GB })];
  await replicateCluster(cluster.id, true);
  assert.equal(host.srv_3.replicaTables.at(-1)!.entries.length, 1);
  await replicateCluster(cluster.id, true);
  assert.equal(
    host.srv_3.replicaTables.at(-1)!.entries.length,
    1,
    "still handed once its copy is known whole",
  );
});

// c41: lab-big's copy on eu-3 was whole at 660 MB; the App then wrote 1 GB, and the catch-up took eu-3 from 84 to 89%.
test("a whole copy its App outgrew is held back like a new one, shown on the server and said once", async () => {
  const cluster = await replicated();
  const MB = 1024 ** 2;
  const GB = 1024 * MB;
  host.srv_2.capabilities.push(VOLUME_USAGE_CAPABILITY);
  host.srv_2.extra.volumeUsage = async () =>
    new Map([["deplo-web-data", 1700 * MB]]);
  host.srv_4.replicaReports = [report({ bytes: 1700 * MB })];
  host.srv_3.extra.metrics = disk(14 * GB, Math.round(11.9 * GB));
  host.srv_3.replicaReports = [report({ bytes: 676 * MB })];
  await replicateCluster(cluster.id, true);
  assert.deepEqual(host.srv_3.replicaTables.at(-1)!.entries, []);
  assert.equal(host.srv_4.replicaTables.at(-1)!.entries.length, 1);
  const members = await asAdmin(() => listClusterMembers(cluster.id));
  assert.match(
    members.find((m) => m.serverId === "srv_3")!.copyWarning,
    /server-3 has 2\.1 GB free, too little for a copy of web/,
  );
  await replicateCluster(cluster.id, true);
  const lines = (await said()).filter((m) =>
    m.includes("too little for a copy of web"),
  );
  assert.equal(lines.length, 1, "Activity says it once");
});

// c44: lab-kit-c (520 MiB) refused on eu-1 wrote three Activity lines in 61 s, its free space in each, and the first
// said 685.8 MB: its biggest file counted twice. One line, with the copy's size.
test("a copy held back for room is said once with its size, whatever the passes in between read", async () => {
  const cluster = await replicated();
  const MB = 1024 ** 2;
  const GB = 1024 * MB;
  host.srv_2.capabilities.push(VOLUME_USAGE_CAPABILITY);
  host.srv_2.extra.volumeSizes = async () => ({
    bytes: 520 * MB,
    largest: 140 * MB,
  });
  const partial = [
    report({ synced: false, bytes: 100 * MB, diskBytes: 100 * MB }),
  ];
  host.srv_3.extra.metrics = disk(14 * GB, Math.round(12.2 * GB));
  host.srv_3.replicaReports = partial;
  await replicateCluster(cluster.id, true);
  host.srv_3.unreachable = true;
  await replicateCluster(cluster.id, true);
  host.srv_3.unreachable = false;
  host.srv_3.extra.metrics = disk(14 * GB, Math.round(12.3 * GB));
  host.srv_3.replicaReports = partial;
  await replicateCluster(cluster.id, true);
  const lines = (await said()).filter((m) =>
    m.includes("too little for a copy of web"),
  );
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /\(about 520\.0 MB\)/);
});

// eu, 24 Nov 2026: lab-fit3's copy began while the App was small, grew with it and took eu-1 to 92%.
test("a copy not whole yet stops once the disk would be under a tenth free, however much of it came", async () => {
  const cluster = await replicated();
  const GB = 1024 ** 3;
  host.srv_2.capabilities.push(VOLUME_USAGE_CAPABILITY);
  host.srv_2.extra.volumeUsage = async () =>
    new Map([["deplo-web-data", 0.7 * GB]]);
  host.srv_3.extra.metrics = disk(14 * GB, 13 * GB);
  host.srv_3.replicaReports = [report({ synced: false, bytes: 0.7 * GB })];
  await replicateCluster(cluster.id, true);
  assert.deepEqual(
    host.srv_3.replicaTables.at(-1)!.entries,
    [],
    "srv_3 drops the copy it was making",
  );
  const members = await asAdmin(() => listClusterMembers(cluster.id));
  assert.match(
    members.find((m) => m.serverId === "srv_3")!.copyWarning,
    /server-3 has 1\.0 GB free, too little for a copy of web \(about 716\.8 MB\)/,
  );
});

// eu, 24 Nov 2026: no warning showed while copies filled eu-1 and eu-3; the agent now stops one at a tenth free.
test("a copy its server stopped for room is held back, shown on the server and said once in Activity", async () => {
  const cluster = await replicated();
  const GB = 1024 ** 3;
  host.srv_2.capabilities.push(VOLUME_USAGE_CAPABILITY);
  host.srv_2.extra.volumeUsage = async () =>
    new Map([["deplo-web-data", 2 * GB]]);
  // Deplo's measure says it fits; the copy turned out bigger, and the agent stopped it. srv_4's copy is whole.
  host.srv_4.replicaReports = [report()];
  host.srv_3.extra.metrics = disk(14 * GB, 10 * GB);
  host.srv_3.replicaReports = [
    report({
      synced: false,
      bytes: 1.5 * GB,
      error:
        "replica: big: this server has 1.4 GB free, too little to go on with this copy and keep a tenth of its disk free",
    }),
  ];
  await replicateCluster(cluster.id, true);
  assert.deepEqual(host.srv_3.replicaTables.at(-1)!.entries, []);
  const members = await asAdmin(() => listClusterMembers(cluster.id));
  assert.match(
    members.find((m) => m.serverId === "srv_3")!.copyWarning,
    /server-3 has 4\.0 GB free, too little for a copy of web \(about 2\.0 GB\)/,
  );
  await replicateCluster(cluster.id, true);
  const lines = (await said()).filter((m) =>
    m.includes("too little for a copy of web"),
  );
  assert.equal(lines.length, 1, "Activity says it once");
  assert.match(lines[0]!, /Free some space on it, and the copy starts\.$/);

  // Gone from its disk, the copy needs a fifth more room than it takes before it is handed again.
  host.srv_3.replicaReports = [];
  host.srv_3.extra.metrics = disk(14 * GB, 10.4 * GB);
  await replicateCluster(cluster.id, true);
  assert.deepEqual(host.srv_3.replicaTables.at(-1)!.entries, []);
  host.srv_3.extra.metrics = disk(14 * GB, 9 * GB);
  await replicateCluster(cluster.id, true);
  assert.equal(host.srv_3.replicaTables.at(-1)!.entries.length, 1);
});

test("a backup refused for room on a server's disk shows on that server, naming the App", async () => {
  const cluster = await replicated();
  await db.insert(backupDestination).values({
    id: "dst_3",
    teamId: "team_a",
    name: "server-3's disk",
    kind: "server",
    serverId: "srv_3",
    ageRecipient: "age1x",
    ageIdentityEnc: "enc",
    status: "ok",
    createdAt: new Date().toISOString(),
  });
  const run = (
    id: string,
    status: string,
    error: string | null,
    at: number,
  ) => ({
    id,
    teamId: "team_a",
    targetKind: "app",
    appId: "prj_web",
    targetId: "prj_web",
    destinationId: "dst_3",
    objectKey: "",
    sizeBytes: 0,
    status,
    error,
    startedAt: new Date(Date.now() - at).toISOString(),
  });
  const refused =
    "server-3 has 1.2 GB free, too little for this backup (about 2.0 GB) and a tenth of its disk free, so it did not start";
  await db
    .insert(backupRuns)
    .values([
      run("brun_1", "success", null, 60_000),
      run("brun_2", "failed", refused, 1_000),
    ]);
  const members = await asAdmin(() => listClusterMembers(cluster.id));
  assert.equal(
    members.find((m) => m.serverId === "srv_3")!.copyWarning,
    `Backup of web: ${refused}.`,
  );
  // The next run landed: nothing to say.
  await db.insert(backupRuns).values(run("brun_3", "success", null, 0));
  const later = await asAdmin(() => listClusterMembers(cluster.id));
  assert.equal(later.find((m) => m.serverId === "srv_3")!.copyWarning, "");
});

// eu-4, 24 Nov 2026 (canary.87): Deplo counted the blocks kept for root as free, so a copy that did not fit was
// handed, written to the agent's stop at a tenth free, removed, and handed again every 80 s.
test("a copy fits only in what the disk lets it write, not in the blocks kept for root", async () => {
  const cluster = await replicated();
  const GB = 1024 ** 3;
  host.srv_2.capabilities.push(VOLUME_USAGE_CAPABILITY);
  host.srv_2.extra.volumeUsage = async () =>
    new Map([["deplo-web-data", 1.6 * GB]]);
  // 14 GB, 11 GB used, 2.4 GB of the 3 GB left writable (80.9% of used and writable): no room for 1.6 GB.
  host.srv_3.extra.metrics = (async () => ({
    diskTotal: 14 * GB,
    diskUsed: 11 * GB,
    diskPct: (11 / 13.4) * 100,
  })) as unknown as () => Promise<HostMetrics>;
  await replicateCluster(cluster.id, true);
  assert.deepEqual(host.srv_3.replicaTables.at(-1)!.entries, []);
  const [why] = await db
    .select({ error: clusterAppReplicas.error })
    .from(clusterAppReplicas)
    .where(eq(clusterAppReplicas.serverId, "srv_3"));
  assert.match(
    why!.error,
    /^server-3 has 2\.4 GB free, too little for a copy of web/,
  );
});

// eu, 24 Nov 2026: a copy of a big file that changes takes twice its size while it is rebuilt.
test("a copy starts only if a tenth stays free with its biggest file held twice", async () => {
  const cluster = await replicated();
  const GB = 1024 ** 3;
  host.srv_2.capabilities.push(VOLUME_USAGE_CAPABILITY);
  host.srv_2.extra.volumeSizes = async () => ({
    bytes: 1 * GB,
    largest: 1 * GB,
  });
  // 3.2 GB free of 14: the rest of the copy (0.9 GB) fits a tenth, the rebuild of its 1 GB file beside it does not.
  host.srv_3.extra.metrics = disk(14 * GB, 10.8 * GB);
  host.srv_3.replicaReports = [
    report({
      synced: false,
      bytes: 100 * 1024 ** 2,
      diskBytes: 100 * 1024 ** 2,
    }),
  ];
  await replicateCluster(cluster.id, true);
  assert.deepEqual(host.srv_3.replicaTables.at(-1)!.entries, []);
  host.srv_3.extra.metrics = disk(14 * GB, 9 * GB);
  await replicateCluster(cluster.id, true);
  assert.equal(host.srv_3.replicaTables.at(-1)!.entries.length, 1);
});

// eu, 24 Nov 2026: a copy's bytes counted every rebuild, so the panel's size of it ran high and its estimate low.
test("a copy's size is what it takes on disk, and whether it went through Deplo", async () => {
  const cluster = await replicated();
  host.srv_3.replicaReports = [
    report({ bytes: 3 * 1024 ** 3, diskBytes: 1024 ** 3, relayed: true }),
  ];
  host.srv_4.replicaReports = [report({ bytes: 5000 })];
  await replicateCluster(cluster.id, true);
  const rows = await db.select().from(clusterAppReplicas);
  const of = (id: string) => rows.find((r) => r.serverId === id)!;
  assert.equal(of("srv_3").bytes, 1024 ** 3);
  assert.equal(of("srv_3").relayed, true);
  // An agent that does not say its size on disk keeps what it said before.
  assert.equal(of("srv_4").bytes, 5000);
  assert.equal(of("srv_4").relayed, false);
});

// eu, 24 Nov 2026: eu-4, back with 4.3 GB free, was refused a fresh 1.6 GB copy as if its file were rebuilt.
test("a fresh copy writes each file once, so its biggest file is not counted twice", async () => {
  const cluster = await replicated();
  const GB = 1024 ** 3;
  host.srv_2.capabilities.push(VOLUME_USAGE_CAPABILITY);
  host.srv_2.extra.volumeSizes = async () => ({
    bytes: 1 * GB,
    largest: 1 * GB,
  });
  host.srv_3.extra.metrics = disk(14 * GB, 10.7 * GB);
  host.srv_3.replicaReports = [
    report({ synced: false, bytes: 0, diskBytes: 0 }),
  ];
  await replicateCluster(cluster.id, true);
  assert.equal(host.srv_3.replicaTables.at(-1)!.entries.length, 1);
});

// c37: eu-2 (one core) took a backup and two replicas at once, and every App through it timed out.
test("a server takes one new copy at a time: the next waits its turn and says so", async () => {
  const cluster = await replicated();
  await replicateCluster(cluster.id, true);
  const handedTo = (id: string) =>
    (host[id].replicaTables.at(-1)?.entries ?? []).map((e) => e.appId);
  const [first, next] = handedTo("srv_3").length
    ? ["srv_3", "srv_4"]
    : ["srv_4", "srv_3"];
  assert.deepEqual(handedTo(first), ["prj_web"]);
  assert.deepEqual(handedTo(next), [], "server-2 already sends one copy");
  const [queued] = await db
    .select()
    .from(clusterAppReplicas)
    .where(eq(clusterAppReplicas.serverId, next));
  assert.equal(
    queued.error,
    "Queued: 1st in line: server-2 is busy with a copy of web",
  );

  // Not whole yet: the next still waits.
  host[first].replicaReports = [report({ synced: false })];
  await replicateCluster(cluster.id);
  assert.deepEqual(handedTo(next), []);
  // Whole but behind, catching up on what the App wrote since: still under way.
  host[first].replicaReports = [
    report({ appliedAt: new Date(Date.now() - 60_000).toISOString() }),
  ];
  await replicateCluster(cluster.id);
  assert.deepEqual(handedTo(next), []);
  // Whole: the next starts.
  host[first].replicaReports = [report()];
  await replicateCluster(cluster.id);
  assert.deepEqual(handedTo(next), ["prj_web"]);
});

// c38: lab-pd's copy on eu-4, handed while lab-pd was still empty, took its 300 MB as followed changes beside a
// backup into eu-4, and the queue did not count it. A copy that moves data counts, and waits whole while it cannot.
test("a copy that moves data while its server copies something else waits its turn, kept whole", async () => {
  const cluster = await replicated();
  host.srv_3.replicaReports = [report()];
  host.srv_4.replicaReports = [report()];
  await replicateCluster(cluster.id, true);
  const handed = (id: string) => host[id].replicaTables.at(-1)!.entries;
  assert.deepEqual(
    handed("srv_4").map((e) => [e.appId, e.hold ?? ""]),
    [["prj_web", ""]],
  );
  const release = holdTurn(["srv_4"], "a backup of shop");
  try {
    host.srv_4.replicaReports = [report({ bytes: 4096 + 20 * 1024 * 1024 })];
    await replicateCluster(cluster.id);
    assert.match(
      handed("srv_4")[0].hold ?? "",
      /^Queued: .+ is busy with a backup of shop$/,
    );
    assert.equal(handed("srv_3")[0].hold ?? "", "", "srv_3's copy follows");
  } finally {
    release();
  }
  // The agent keeps it whole and idle; once the backup is done its turn comes.
  host.srv_4.replicaReports = [
    report({
      role: "idle",
      connected: false,
      appliedAt: "",
      error: "Queued: server-4 is busy with a backup of shop",
    }),
  ];
  await replicateCluster(cluster.id);
  assert.equal(handed("srv_4")[0].hold ?? "", "");
});

// c39: lab-r's backup waited 12 minutes: each time a copy ended, the pass gave its server to a copy that asked later.
test("a backup that asked before a copy keeps its turn when the server is free again", async () => {
  const cluster = await replicated();
  __forgetTurns();
  const move = holdTurn(["srv_2"], "the move of blog");
  const stop = new AbortController();
  const poll = turnWait.pollMs;
  turnWait.pollMs = 60_000;
  const backup = takeTurn(["srv_2"], "a backup of shop", {
    signal: stop.signal,
  });
  try {
    await replicateCluster(cluster.id, true);
    move();
    // The move is done, and the backup has not looked again yet: the pass must still leave server-2 to it.
    await replicateCluster(cluster.id);
    for (const id of ["srv_3", "srv_4"])
      assert.deepEqual(
        (host[id].replicaTables.at(-1)?.entries ?? []).map((e) => e.appId),
        [],
        `${id} got a copy that asked after the backup`,
      );
    const rows = await db.select().from(clusterAppReplicas);
    assert.ok(
      rows.some(
        (r) =>
          r.error ===
          "Queued: 2nd in line: server-2 takes a backup of shop first",
      ),
      rows.map((r) => r.error).join(" | "),
    );
  } finally {
    stop.abort();
    (await backup)();
    turnWait.pollMs = poll;
    __forgetTurns();
  }
});

// c38: every copy read Behind together for about 35 s: Deplo's pass came late under load, not the copies.
test("a copy is behind by what its server said, never by how late Deplo asked", () => {
  const now = Date.parse("2026-11-25T01:00:00.000Z");
  const at = (ago: number) => new Date(now - ago).toISOString();
  const row = (checked: number, applied: number) => ({
    appId: "prj_web",
    serverId: "srv_3",
    role: "receiving",
    connected: true,
    synced: true,
    appliedAt: at(applied),
    bytes: 0,
    relayed: false,
    error: "",
    checkedAt: at(checked),
  });
  assert.equal(following(row(40_000, 41_000), now), true);
  assert.equal(following(row(5_000, 40_000), now), false);
  assert.equal(
    following(row(3 * 60_000, 3 * 60_000 + 1_000), now),
    false,
    "a status read three minutes ago says nothing of now",
  );
});
