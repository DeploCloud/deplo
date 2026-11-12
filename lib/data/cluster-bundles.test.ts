import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedPreview,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { appBuild, apps as appsTable } from "../db/schema/control-plane/apps";
import { rerouteApp } from "../deploy/build/reroute";
import {
  clusterLeaderKeys,
  clusters as clustersTable,
  failoverBundlePushes,
} from "../db/schema/control-plane/clusters";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import {
  __setRunnerForTest,
  __resetQueueForTest,
} from "../deploy/deploy-queue";
import { runAgentDeploy } from "../deploy/agent-deploy";
import { addRegistry } from "./registries";
import {
  clearContainerHistory,
  recordContainerSample,
} from "../monitoring/container-history";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { reconcileCluster } from "./clusters/watch";
import {
  flushFailoverBundles,
  scheduleFailoverBundle,
  keyFingerprint,
  reconcileFailoverBundles,
  type FailoverBundle,
} from "./clusters/bundles";
import { invalidateFrozen } from "./deplo-move/freeze";
import { createApp } from "./apps/create";
import { deleteApp } from "./apps/delete";
import { moveAppToServer } from "./apps/source";
import { pushAppBundle } from "./clusters/app-restore";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const COMPOSE =
  'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "80"\n';
const everyone = { allTeams: true, teamIds: [] as string[] };
const enc = new TextEncoder();
const dec = new TextDecoder();

// A leader as the agent forwards to it: its own age identity, and the sealed bundles it holds.
interface TestLeader {
  identity: string;
  publicKey: string;
  held: Map<string, { deploymentId: string; sealed: Uint8Array }>;
  /** What the leader places each workload by, as last sent. */
  metas: Map<string, { peakMb: number; limitMb: number }>;
  dropped: string[];
  refuseKey: boolean;
  refusePut: boolean;
}

async function newLeader(): Promise<TestLeader> {
  const age = await import("age-encryption");
  const identity = await age.generateX25519Identity();
  return {
    identity,
    publicKey: await age.identityToRecipient(identity),
    held: new Map(),
    metas: new Map(),
    dropped: [],
    refuseKey: false,
    refusePut: false,
  };
}

const answer = (v: unknown) => enc.encode(JSON.stringify(v));

function leaderCalls(l: TestLeader) {
  return (method: string, payload: Uint8Array): Uint8Array => {
    const body = payload.length
      ? (JSON.parse(dec.decode(payload)) as Record<string, string>)
      : {};
    if (method === "leader.key") {
      if (l.refuseKey) throw new Error("leader down");
      return answer({ publicKey: l.publicKey });
    }
    if (method === "leader.bundle.put") {
      if (l.refusePut) throw new Error("disk full");
      l.metas.set(
        body.id,
        body.meta as unknown as { peakMb: number; limitMb: number },
      );
      l.held.set(body.id, {
        deploymentId: body.deploymentId,
        sealed: Buffer.from(body.sealed, "base64"),
      });
      return answer({});
    }
    if (method === "leader.bundle.drop") {
      l.dropped.push(body.id);
      l.held.delete(body.id);
      return answer({});
    }
    if (method === "leader.bundle.list")
      return answer({
        bundles: [...l.held].map(([id, b]) => ({
          kind: "app",
          id,
          deploymentId: b.deploymentId,
        })),
      });
    if (method === "leader.snapshot") return answer({ head: 0, clusters: {} });
    return payload;
  };
}

async function open(l: TestLeader, id: string): Promise<FailoverBundle> {
  const age = await import("age-encryption");
  const d = new age.Decrypter();
  d.addIdentity(l.identity);
  return JSON.parse(
    await d.decrypt(l.held.get(id)!.sealed, "text"),
  ) as FailoverBundle;
}

let leader: TestLeader;
let hosts: Record<string, FakeClusterHost> = {};

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setRunnerForTest(async () => {});
});

after(async () => {
  __resetTestDb();
  __resetQueueForTest();
  await pg.close();
});

const RUNNING = {
  installed: true,
  running: true,
  version: "0.2.0",
  relay: true,
  member: false,
  relayLinks: 0,
};

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters, failover_bundle_pushes, activities, registries, deplo_moves, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  for (const [i, id] of ["srv_2", "srv_3"].entries()) {
    await seedServerRow(db, {
      id,
      ip: `10.0.0.${i + 2}`,
      host: `10.0.0.${i + 2}`,
    });
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: String(i + 2).repeat(64) })
      .where(eq(serversTable.id, id));
  }
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: "1".repeat(64) })
    .where(eq(serversTable.id, SERVER_1));
  leader = await newLeader();
  fleet = fakeClusterHosts();
  hosts = {};
  hosts[SERVER_1] = fleet.host(SERVER_1, {
    status: RUNNING,
    leader: (m, p) => {
      if (m === "placement.place") return answer({ member: "srv_2" });
      return leaderCalls(leader)(m, p);
    },
  });
  for (const id of ["srv_2", "srv_3"]) hosts[id] = fleet.host(id);
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
  invalidateFrozen();
});

afterEach(async () => {
  await flushFailoverBundles();
  fleet.restore();
  __setClusterPinForTest(null);
  __resetReleaseCacheForTests();
  globalThis.fetch = origFetch;
  if (origIp === undefined) delete process.env.DEPLO_SERVER_IP;
  else process.env.DEPLO_SERVER_IP = origIp;
  invalidateFrozen();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

async function eu() {
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
  return cluster;
}

async function clusterApp(clusterId: string, name = "web") {
  const app = await asAdmin(() =>
    createApp({
      name,
      source: "compose",
      repo: null,
      compose: COMPOSE.replace("web", name),
      deploy: false,
      clusterId,
    }),
  );
  return app;
}

// What a successful deploy does on the member; the bundle follows it.
async function deployOn(
  app: { id: string; slug: string },
  deployId: string,
  over: {
    env?: Record<string, string>;
    pull?: boolean;
    built?: boolean;
  } = {},
) {
  await seedDeployment(db, { id: deployId, appId: app.id, status: "ready" });
  const result = await runAgentDeploy({
    serverId: "srv_2",
    deployId,
    slug: app.slug,
    appId: app.id,
    imageRef: "nginx:1.27",
    composeYaml: COMPOSE,
    network: "deplo-team-x",
    env: over.env ?? { DATABASE_URL: "postgres://u:p@db/x", API_KEY: "k-123" },
    plan:
      over.pull || over.built
        ? { kind: "image", image: "nginx:1.27", pull: !over.built }
        : { kind: "compose", mounts: [] },
    githubToken: "ghp_not_for_the_leader",
    sink: { log: () => {} },
  });
  assert.equal(result.ready, true);
  await flushFailoverBundles();
}

async function activityFor(appId: string) {
  const rows = await db
    .select()
    .from(activities)
    .where(eq(activities.appId, appId));
  return rows.filter((r) => /fail over/.test(r.message));
}

test("the sealed bundle opens with the leader's key and holds what the member's deploy received, nothing else", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await asAdmin(() =>
    addRegistry({
      name: "GHCR",
      type: "ghcr",
      username: "octocat",
      password: "ghp_secret",
    }),
  );
  await deployOn(app, "dpl_1");

  const member = hosts.srv_2.deploys;
  assert.equal(member.length, 1);
  const req = member[0];

  const bundle = await open(leader, app.id);
  assert.deepEqual(Object.keys(bundle).sort(), [
    "deploymentId",
    "kind",
    "stack",
    "v",
    "workload",
  ]);
  assert.equal(bundle.deploymentId, "dpl_1");
  assert.equal(bundle.workload, app.id);
  assert.deepEqual(Object.keys(bundle.stack).sort(), [
    "composeUpArgs",
    "composeYaml",
    "env",
    "imageRef",
    "network",
    "projectId",
    "registryAuth",
    "slug",
  ]);
  assert.equal(bundle.stack.composeYaml, req.composeYaml);
  assert.deepEqual(bundle.stack.env, req.env);
  assert.equal(bundle.stack.imageRef, req.imageRef);
  assert.equal(bundle.stack.network, req.network);
  assert.deepEqual(bundle.stack.registryAuth, req.registryAuth);
  assert.equal(bundle.stack.registryAuth[0].password, "ghp_secret");
  assert.doesNotMatch(JSON.stringify(bundle), /ghp_not_for_the_leader/);

  // Ciphertext at the leader: no plaintext secret in what it stores, and only its identity opens it.
  const sealed = leader.held.get(app.id)!.sealed;
  assert.doesNotMatch(Buffer.from(sealed).toString("latin1"), /k-123/);
  const other = await newLeader();
  await assert.rejects(open({ ...other, held: leader.held }, app.id));

  const rows = await db.select().from(failoverBundlePushes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].keyFingerprint, keyFingerprint(leader.publicKey));
  assert.equal(rows[0].deploymentId, "dpl_1");
  assert.ok(rows[0].pushedAt);
  assert.doesNotMatch(rows[0].bundleEnc, /k-123/);
  const keys = await db.select().from(clusterLeaderKeys);
  assert.deepEqual(
    keys.map((k) => k.publicKey),
    [leader.publicKey],
  );
});

test("the bundle keeps the deploy's ready check, restart rule and files, so a moved App is checked and restarted as before", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  hosts.srv_2.capabilities.push("deploy.ready-check", "health.restart");
  await seedDeployment(db, { id: "dpl_1", appId: app.id, status: "ready" });
  await runAgentDeploy({
    serverId: "srv_2",
    deployId: "dpl_1",
    slug: app.slug,
    appId: app.id,
    imageRef: "nginx:1.27",
    composeYaml: COMPOSE,
    network: "deplo-team-x",
    env: {},
    plan: {
      kind: "compose",
      mounts: [{ filePath: "config/app.toml", content: "a = 1" }],
    },
    ready: { port: 3000, portRequired: true, service: "web" },
    sink: { log: () => {} },
  });
  await flushFailoverBundles();

  const sent = hosts.srv_2.deploys[0];
  assert.ok(sent.restartRule, "the deploy itself carried a restart rule");
  const { stack } = await open(leader, app.id);
  assert.deepEqual(stack.ready, {
    port: 3000,
    portRequired: true,
    service: "web",
  });
  assert.deepEqual(stack.restartRule, {
    probe: "PROBE_HTTP",
    port: 3000,
    path: "/",
    intervalS: 30,
    timeoutS: 10,
    retries: 3,
    startPeriodS: 60,
    service: "web",
  });
  assert.deepEqual(stack.mounts, [
    { path: "config/app.toml", content: "a = 1" },
  ]);
  assert.equal(stack.startAfterReady, undefined, "nothing starts late here");
});

test("the services a deploy starts only after it is ready travel in the bundle", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await seedDeployment(db, { id: "dpl_1", appId: app.id, status: "ready" });
  scheduleFailoverBundle({
    appId: app.id,
    deploymentId: "dpl_1",
    stack: {
      slug: app.slug,
      projectId: app.id,
      imageRef: "nginx:1.27",
      composeYaml: COMPOSE,
      network: "deplo-team-x",
      env: {},
      registryAuth: [],
      composeUpArgs: [],
      startAfterReady: ["connector"],
    },
  });
  await flushFailoverBundles();
  assert.deepEqual((await open(leader, app.id)).stack.startAfterReady, [
    "connector",
  ]);
});

test("a pulled image's bundle carries the registry credentials, a built one's does not", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await asAdmin(() =>
    addRegistry({ name: "GHCR", type: "ghcr", username: "o", password: "pw" }),
  );
  await deployOn(app, "dpl_1", { pull: true });
  assert.equal((await open(leader, app.id)).stack.registryAuth.length, 1);

  await deployOn(app, "dpl_2", { built: true });
  const built = await open(leader, app.id);
  assert.equal(built.deploymentId, "dpl_2");
  assert.deepEqual(built.stack.registryAuth, []);
});

test("every leader key the cluster holds gets its own sealed copy", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  const second = await newLeader();
  hosts.srv_3 = fleet.host("srv_3", {
    status: RUNNING,
    leader: leaderCalls(second),
  });
  // The leader runs on srv_3 (#215): its key and the one on Deplo's machine both hold bundles.
  await db
    .update(clustersTable)
    .set({ leaderServerId: "srv_3" })
    .where(eq(clustersTable.id, cluster.id));
  await deployOn(app, "dpl_1");

  const a = await open(leader, app.id);
  const b = await open(second, app.id);
  assert.deepEqual(a, b);
  const rows = await db.select().from(failoverBundlePushes);
  assert.deepEqual(
    rows.map((r) => r.keyFingerprint).sort(),
    [keyFingerprint(leader.publicKey), keyFingerprint(second.publicKey)].sort(),
  );
});

test("an App outside any cluster, or a preview deploy, gets no bundle", async () => {
  await seedApp(db, { id: "prj_plain", teamId: TEAM_A, slug: "plain" });
  await deployOn({ id: "prj_plain", slug: "plain" }, "dpl_p");
  assert.equal(leader.held.size, 0);

  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await seedPreview(db, { id: "prv_1", appId: app.id, prNumber: 7 });
  await seedDeployment(db, {
    id: "dpl_pv",
    appId: app.id,
    previewId: "prv_1",
  });
  const result = await runAgentDeploy({
    serverId: "srv_2",
    deployId: "dpl_pv",
    slug: app.slug,
    appId: app.id,
    imageRef: "nginx:1.27",
    composeYaml: COMPOSE,
    network: "deplo-preview-x",
    env: {},
    plan: { kind: "compose", mounts: [] },
    sink: { log: () => {} },
  });
  assert.equal(result.ready, true);
  await flushFailoverBundles();
  assert.equal(leader.held.size, 0);
  assert.equal((await db.select().from(failoverBundlePushes)).length, 0);
});

test("a leader that did not answer leaves Activity saying the App cannot fail over", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  leader.refuseKey = true;
  await deployOn(app, "dpl_1");

  const rows = await activityFor(app.id);
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /web cannot fail over yet/);
  assert.match(rows[0].message, /Cluster eu/);
  assert.equal(rows[0].teamId, TEAM_A);
  assert.equal(leader.held.size, 0);

  // The same reason is said once, not on every deploy.
  await deployOn(app, "dpl_2");
  assert.equal((await activityFor(app.id)).length, 1);
});

test("a leader that refuses the bundle keeps it for the next try, and says so", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  leader.refusePut = true;
  await deployOn(app, "dpl_1");
  const [row] = await db.select().from(failoverBundlePushes);
  assert.equal(row.pushedAt, null);
  assert.match((await activityFor(app.id))[0].message, /cannot fail over yet/);

  leader.refusePut = false;
  await reconcileFailoverBundles();
  assert.equal(leader.held.get(app.id)?.deploymentId, "dpl_1");
  const [after] = await db.select().from(failoverBundlePushes);
  assert.ok(after.pushedAt);
});

test("a relink with a new leader key seals the stored bundle to it and sends it again", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await deployOn(app, "dpl_1");
  const oldKey = leader.publicKey;

  // The leader was reinstalled: a new key, nothing held.
  const fresh = await newLeader();
  leader.identity = fresh.identity;
  leader.publicKey = fresh.publicKey;
  leader.held.clear();
  await reconcileFailoverBundles();

  assert.equal(leader.held.get(app.id)?.deploymentId, "dpl_1");
  const bundle = await open(leader, app.id);
  assert.equal(bundle.deploymentId, "dpl_1");
  assert.equal(bundle.stack.env.API_KEY, "k-123");
  const keys = await db.select().from(clusterLeaderKeys);
  assert.deepEqual(
    keys.map((k) => k.publicKey),
    [fresh.publicKey],
    "the old key is gone",
  );
  assert.notEqual(oldKey, fresh.publicKey);
  const rows = await db.select().from(failoverBundlePushes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].keyFingerprint, keyFingerprint(fresh.publicKey));
});

test("a relink compares deployment ids: a leader behind gets the live one, one that is current gets nothing", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await deployOn(app, "dpl_1");
  const puts = () => fleetCalls(SERVER_1, "leader.bundle.put");
  const before = puts().length;
  await reconcileFailoverBundles();
  assert.equal(puts().length, before, "current: nothing is resent");

  leader.held.get(app.id)!.deploymentId = "dpl_0";
  await reconcileFailoverBundles();
  assert.equal(puts().length, before + 1);
  assert.equal(leader.held.get(app.id)!.deploymentId, "dpl_1");
});

test("a watch that reconnects resends the bundle a leader missed, without waiting for the sweep", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await deployOn(app, "dpl_1");
  leader.held.get(app.id)!.deploymentId = "dpl_0";
  await reconcileCluster(cluster.id);
  assert.equal(leader.held.get(app.id)!.deploymentId, "dpl_1");
});

test("the bundle tells the leader the App's 24-hour peak, so a failover finds real room", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  clearContainerHistory();
  recordContainerSample({
    id: app.id,
    online: true,
    ts: Date.now(),
    cpu: 0,
    memUsed: 3000 * 1024 * 1024,
    memLimit: 0,
    memPct: 0,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 1,
    running: 1,
    containers: 1,
    hostCores: 2,
  });
  await deployOn(app, "dpl_1");
  assert.deepEqual(
    [leader.metas.get(app.id)?.limitMb, leader.metas.get(app.id)?.peakMb],
    [0, 3000],
  );
  clearContainerHistory();
});

test("a stack that builds its own images says, once, that they exist only on its server", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  const push = async (deploymentId: string, composeYaml: string) => {
    await seedDeployment(db, { id: deploymentId, appId: app.id });
    await pushAppBundle({
      appId: app.id,
      deploymentId,
      stack: {
        slug: app.slug,
        projectId: app.id,
        imageRef: "",
        composeYaml,
        network: "deplo-team-x",
        env: {},
        registryAuth: [],
        composeUpArgs: [],
      },
    });
  };

  await push("dpl_1", COMPOSE);
  assert.deepEqual(await activityFor(app.id), []);

  const built = "services:\n  web:\n    build: .\n    image: deplo/web-web\n";
  await push("dpl_2", built);
  await push("dpl_3", built);
  assert.deepEqual(
    (await activityFor(app.id)).map((r) => `${r.actor}: ${r.message}`),
    [
      "Deplo: web does not fail over yet: its compose file builds images, and they exist only on the server that built them. A compose file that names published images does.",
    ],
  );
});

test("a bundle the leader holds for no App of the cluster is dropped", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await deployOn(app, "dpl_1");
  leader.held.set("prj_gone", {
    deploymentId: "dpl_9",
    sealed: enc.encode("x"),
  });
  await reconcileFailoverBundles();
  assert.deepEqual(leader.dropped, ["prj_gone"]);
});

test("a live deploy with no stored bundle is reported, once, with its reason", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await seedDeployment(db, { id: "dpl_1", appId: app.id, status: "ready" });
  await reconcileFailoverBundles();
  await reconcileFailoverBundles();
  const rows = await activityFor(app.id);
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /no saved copy of its last deploy/);
  assert.equal(leader.held.size, 0);
});

const within = <T>(p: Promise<T>, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${what} did not finish`)), 20_000),
    ),
  ]);

test("leaving the cluster drops the App's bundle from the leader and from here", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await deployOn(app, "dpl_1");
  assert.equal(leader.held.size, 1);

  await within(
    asAdmin(() => moveAppToServer(app.id, SERVER_1)),
    "the move",
  );
  assert.deepEqual(leader.dropped, [app.id]);
  assert.equal(leader.held.size, 0);
  assert.equal((await db.select().from(failoverBundlePushes)).length, 0);
});

test("deleting the App drops its bundle from the leader and from here", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id, "api");
  await deployOn(app, "dpl_2");
  assert.equal(leader.held.size, 1);
  await within(
    asAdmin(() => deleteApp(app.id)),
    "the delete",
  );
  assert.deepEqual(leader.dropped, [app.id]);
  assert.equal(leader.held.size, 0);
  assert.equal((await db.select().from(failoverBundlePushes)).length, 0);
});

test("a bundle belongs to its own team's App: another team's cluster App is never in it", async () => {
  const cluster = await eu();
  const mine = await clusterApp(cluster.id);
  await deployOn(mine, "dpl_1");
  leader.refuseKey = true;
  leader.publicKey = "";
  const theirs = await asAdmin(() => clusterApp(cluster.id, "other"));
  await db
    .update(appsTable)
    .set({ teamId: TEAM_B })
    .where(eq(appsTable.id, theirs.id));
  await deployOn(theirs, "dpl_2");
  const mineBundle = await open(
    { ...leader, identity: leader.identity },
    mine.id,
  );
  assert.doesNotMatch(JSON.stringify(mineBundle), /other/);
  const theirRows = await activityFor(theirs.id);
  assert.ok(theirRows.every((r) => r.teamId === TEAM_B));
  assert.equal((await activityFor(mine.id)).length, 0);
});

test("while a Deplo move freezes this instance, nothing is pushed or reconciled", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await db.insert(deploMoves).values({
    id: "dmv_1",
    side: "target",
    state: "copying",
    schedulesPaused: false,
    startedBy: USER_1,
    peerUrl: "https://old.example.com",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  invalidateFrozen();
  await deployOn(app, "dpl_1");
  await reconcileFailoverBundles();
  assert.equal(leader.held.size, 0);
  assert.equal((await db.select().from(failoverBundlePushes)).length, 0);
  assert.equal(fleetCalls(SERVER_1, "leader.key").length, 0);
});

function fleetCalls(serverId: string, method: string) {
  return hosts[serverId].calls.filter((c) => c.method === method);
}

test("a stack deployed beside its old release leaves a bundle that starts it on its own", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  hosts.srv_2.capabilities.push(
    "deploy.overlap",
    "deploy.replicas",
    "deploy.overlap.stack",
  );
  await seedDeployment(db, { id: "dpl_1", appId: app.id, status: "ready" });
  const standIn = COMPOSE.replace("web:", "web_next:");
  const result = await runAgentDeploy({
    serverId: "srv_2",
    deployId: "dpl_1",
    slug: app.slug,
    appId: app.id,
    imageRef: "",
    composeYaml: COMPOSE,
    network: "deplo-team-x",
    env: {},
    plan: { kind: "compose", mounts: [] },
    overlap: { live: COMPOSE, standIn, ports: [], replicas: 2, stack: true },
    sink: { log: () => {} },
  });
  assert.equal(result.ready, true);
  await flushFailoverBundles();

  assert.equal(hosts.srv_2.deploys[0].standInComposeYaml, standIn);
  const bundle = await open(leader, app.id);
  assert.equal(bundle.stack.composeYaml, COMPOSE);
  assert.doesNotMatch(JSON.stringify(bundle), /_next/);
});

test("a reroute after the deploy hands the leader the stack as it runs now, on the port Deplo moved it to", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await db
    .update(appsTable)
    .set({
      source: "docker-image",
      compose: null,
      dockerImage: "nginx:1.27",
      status: "active",
    })
    .where(eq(appsTable.id, app.id));
  hosts.srv_2.capabilities.push("deploy.ready-check", "health.restart");
  await seedDeployment(db, { id: "dpl_1", appId: app.id, status: "ready" });
  await runAgentDeploy({
    serverId: "srv_2",
    deployId: "dpl_1",
    slug: app.slug,
    appId: app.id,
    imageRef: "nginx:1.27",
    composeYaml: "services: {}\n",
    network: "deplo-team-x",
    env: {},
    plan: { kind: "image", image: "nginx:1.27", pull: true },
    ready: { port: 4173, portRequired: true, service: "" },
    sink: { log: () => {} },
  });
  // No flush: Deplo moves it to port 80 while the deploy's own push is still on its way, as it does live.
  await db.update(appBuild).set({ port: 80 }).where(eq(appBuild.appId, app.id));
  hosts.srv_2.stacks[app.slug] =
    `services:\n  deplo-${app.slug}:\n    image: nginx:1.27\n`;

  assert.equal(await rerouteApp(app.id), "rerouted");
  await flushFailoverBundles();

  const { stack, deploymentId } = await open(leader, app.id);
  assert.equal(deploymentId, "dpl_1");
  assert.equal(stack.composeYaml, hosts.srv_2.reroutes[0]!.composeYaml);
  assert.match(stack.composeYaml, /loadbalancer\.server\.port=80/);
  assert.equal((stack.ready as { port: number }).port, 80);
  assert.equal((stack.restartRule as { port: number }).port, 80);
});
