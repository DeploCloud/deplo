import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { parse } from "yaml";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { encryptSecret } from "../crypto";
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
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  clusterImageCopies,
  failoverBundlePushes,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import {
  appPreviews,
  deployments as deploymentsTable,
  pendingTeardowns,
} from "../db/schema/control-plane/deployments";
import {
  appTunnelDomains,
  appTunnels,
  dnsProviders,
} from "../db/schema/control-plane/dns-providers";
import { domains } from "../db/schema/control-plane/domains";
import { envVarTargets, envVars } from "../db/schema/control-plane/env-vars";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import type { DeployRequest } from "../agent/gen/agent";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import { runDeploymentGuarded } from "../deploy/build/deploy-run";
import {
  __resetQueueForTest,
  __setRunnerForTest,
} from "../deploy/deploy-queue";
import { previewHost } from "../deploy/domains";
import { __disablePreviewCommentsForTest } from "../deploy/preview-comment";
import { deployPreviewRow } from "../deploy/preview-lifecycle/deploy";
import { openOrSyncPreview } from "../deploy/preview-lifecycle/open-sync";
import { flushFailoverBundles } from "./clusters/bundles";
import { deleteCluster, removeClusterMember } from "./clusters/dissolve";
import { runEmptyingPass } from "./clusters/empty";
import { syncNameForwarders } from "./clusters/forwarders";
import { copyImageAfterDeploy } from "./clusters/images";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { applyLeaderEvent } from "./clusters/watch";
import { invalidateFrozen } from "./deplo-move/freeze";
import { removeServer } from "./servers/removal";
import {
  destroyPreview,
  listAppPreviews,
  redeployPreview,
  setAppPreviewSettings,
} from "./previews";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let hosts: Record<string, FakeClusterHost> = {};
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const APP = "prj_1";
const PREVIEW = "prv_1";
const KEY = "web__pr-7";
const MEMBERS = ["srv_2", "srv_3", "srv_4"];
const IP: Record<string, string> = {
  srv_2: "203.0.113.2",
  srv_3: "203.0.113.3",
  srv_4: "203.0.113.4",
};
const USER_B = "user_b";
const enc = new TextEncoder();
const dec = new TextDecoder();
const answer = (v: unknown) => enc.encode(JSON.stringify(v));
const hostOn = (serverId: string) =>
  previewHost({ appId: APP, slug: "web", prNumber: 7, ip: IP[serverId] }).host;

// The leader: the member it names (or the refusal it gives), what it was asked, and the bundles sealed to it.
let leader: {
  publicKey: string;
  held: Map<string, Uint8Array>;
  place: string;
  refusal: { reason: string; neededMb: number } | null;
  asked: {
    workload: { kind: string; id: string; name: string; environment: string };
  }[];
};
let clusterId: string;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __disablePreviewCommentsForTest();
});

after(async () => {
  __resetQueueForTest();
  // The queue's last look at the database finishes before it goes.
  await new Promise((r) => setTimeout(r, 50));
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  // A deploy runs only where a test runs it by hand.
  __setRunnerForTest(async () => {});
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters, failover_bundle_pushes, pending_teardowns, dns_providers, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_B, teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  for (const [i, id] of MEMBERS.entries()) {
    await seedServerRow(db, { id, ip: IP[id]!, host: IP[id]! });
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: String(i + 2).repeat(64), name: id })
      .where(eq(serversTable.id, id));
  }
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: "1".repeat(64) })
    .where(eq(serversTable.id, SERVER_1));

  const age = await import("age-encryption");
  leader = {
    publicKey: await age.identityToRecipient(
      await age.generateX25519Identity(),
    ),
    held: new Map(),
    place: "srv_3",
    refusal: null,
    asked: [],
  };
  fleet = fakeClusterHosts();
  hosts = {};
  hosts[SERVER_1] = fleet.host(SERVER_1, {
    status: {
      installed: true,
      running: true,
      version: "0.2.0",
      relay: true,
      member: false,
      relayLinks: 0,
    },
    leader: (method, payload) => {
      const body = payload.length ? JSON.parse(dec.decode(payload)) : {};
      if (method === "placement.place") {
        leader.asked.push(body);
        return answer(
          leader.refusal
            ? {
                refusal: {
                  ...leader.refusal,
                  cluster: body.cluster,
                  workload: body.workload.id,
                },
              }
            : { member: leader.place },
        );
      }
      if (method === "leader.key")
        return answer({ publicKey: leader.publicKey });
      if (method === "leader.bundle.put") {
        leader.held.set(body.id, Buffer.from(body.sealed, "base64"));
        return answer({});
      }
      if (method === "leader.bundle.list") return answer({ bundles: [] });
      return payload;
    },
  });
  for (const id of MEMBERS) {
    hosts[id] = fleet.host(id);
    hosts[id].capabilities.push(
      "deploy.network",
      "deploy.image",
      "deploy.railpack",
      "deploy.ready-check",
    );
    hosts[id].extra = { listInstances: async () => [] };
  }
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
  invalidateFrozen();

  // An App on srv_2 with one open pull request, in a cluster of three servers.
  await seedApp(db, { id: APP, slug: "web", repo: null, serverId: "srv_2" });
  await db
    .update(appsTable)
    .set({
      name: "web",
      source: "docker-image",
      dockerImage: "nginx:1.27",
      previewEnabled: true,
    })
    .where(eq(appsTable.id, APP));
  const cluster = await asAdmin(() =>
    createCluster("eu", { allTeams: false, teamIds: [TEAM_A] }),
  );
  clusterId = cluster.id;
  for (const id of MEMBERS)
    await asAdmin(() => addClusterMember(cluster.id, id));
  await seedPreview(db, {
    id: PREVIEW,
    appId: APP,
    prNumber: 7,
    status: "queued",
    host: hostOn("srv_2"),
    approvedAt: "2026-11-08T00:00:00.000Z",
  });
});

afterEach(async () => {
  __resetQueueForTest();
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
const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_B, teamId: TEAM_B }, fn);

// The App's Cloudflare domain, served through its own tunnel: production carries the connector.
async function withTunnel() {
  const now = "2026-11-08T00:00:00.000Z";
  await db.insert(domains).values({
    id: "dom_1",
    appId: APP,
    name: "web.example.com",
    status: "valid",
    isPrimary: true,
    ssl: false,
    certProvider: "none",
    port: 3000,
    createdAt: now,
  });
  await db.insert(dnsProviders).values({
    id: "dns_1",
    userId: USER_1,
    provider: "cloudflare",
    zoneName: "example.com",
    zoneId: "zone1",
    accountId: "acct1",
    apiTokenEnc: encryptSecret("cf-token"),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(appTunnels).values({
    appId: APP,
    providerId: "dns_1",
    tunnelId: "tun_1",
    tokenEnc: encryptSecret("tunnel-token"),
    createdAt: now,
  });
  await db.insert(appTunnelDomains).values({
    domainId: "dom_1",
    appId: APP,
    providerId: "dns_1",
    active: true,
    createdAt: now,
  });
}

const preview = async (id = PREVIEW) =>
  (await db.select().from(appPreviews).where(eq(appPreviews.id, id)))[0]!;

const deployment = async (id: string) =>
  (
    await db.select().from(deploymentsTable).where(eq(deploymentsTable.id, id))
  )[0]!;

/** Starts the preview's deploy and runs it against the fake agents; answers the request the member was handed. */
async function deployPreview(id = PREVIEW): Promise<DeployRequest> {
  const depId = await deployPreviewRow(id, { actor: "Deplo" });
  assert.ok(depId);
  await runDeploymentGuarded(depId);
  const dep = await deployment(depId);
  assert.equal(dep.status, "ready");
  await flushFailoverBundles();
  return hosts[dep.serverId!]!.deploys.at(-1)!;
}

// Nothing stays queued behind a test: the queue would hand it to the next one.
const cancelQueued = () =>
  db
    .update(deploymentsTable)
    .set({ status: "canceled" })
    .where(eq(deploymentsTable.status, "queued"));

const fence = (member: string, seq = 1, state = "fenced") =>
  applyLeaderEvent(clusterId, {
    seq,
    type: "member_state",
    cluster: clusterId,
    data: { member, state },
  });

const read = async () =>
  (await asAdmin(() => listAppPreviews(APP))).previews.find(
    (p) => p.id === PREVIEW,
  )!;
const statusRead = async () => (await read()).status;

test("a preview of a cluster App runs on the member the leader names, with no bundle, no connector and its own network", async () => {
  await withTunnel();
  const req = await deployPreview();

  // The leader was asked about the preview itself, outside any Environment.
  assert.equal(leader.asked.length, 1);
  assert.deepEqual(leader.asked[0]!.workload, {
    kind: "app",
    id: PREVIEW,
    name: "web",
    environment: "",
    limitMb: 0,
    peakMb: 0,
    image: "",
    archs: [],
  });
  assert.equal(hosts.srv_3.deploys.length, 1);
  assert.equal(hosts.srv_2.deploys.length, 0);
  const row = await preview();
  assert.equal(row.serverId, "srv_3");
  assert.equal(row.status, "active");

  // Its own network, and nothing of the App's tunnel.
  assert.equal(req.network, `deplo-preview-${KEY}`);
  const services = Object.keys(
    (parse(req.composeYaml) as { services: object }).services,
  );
  assert.deepEqual(services, ["deplo-web__pr-7"]);
  assert.deepEqual(req.startAfterReady, []);
  assert.doesNotMatch(JSON.stringify(req), /tunnel-token|connector/);

  // No failover bundle, and the leader holds no placement of it to move.
  assert.equal(leader.held.size, 0);
  assert.equal((await db.select().from(failoverBundlePushes)).length, 0);
  assert.deepEqual(
    (await db.select().from(workloadPlacements)).map((p) => p.workloadId),
    [APP],
  );
  const told = hosts[SERVER_1]!.calls.filter(
    (c) => c.method !== "placement.place",
  )
    .map((c) => dec.decode(c.payload))
    .join("\n");
  assert.doesNotMatch(told, /prv_1|web__pr-7/);
  // No member holds or serves a name for it.
  await syncNameForwarders(clusterId);
  for (const id of MEMBERS)
    assert.doesNotMatch(JSON.stringify(hosts[id]!.forwarders), /preview|pr-7/);
});

test("a leader with no room refuses the preview with the same sentence as an App, and nothing is deployed", async () => {
  leader.refusal = { reason: "no_room", neededMb: 256 };
  await assert.rejects(
    deployPreviewRow(PREVIEW, { actor: "Deplo" }),
    (e: Error) =>
      e.message ===
      "No server in cluster eu has 256 MB free. Add a server to it or lower web's memory.",
  );
  assert.equal((await db.select().from(deploymentsTable)).length, 0);
  for (const id of MEMBERS) assert.equal(hosts[id]!.deploys.length, 0);
  const row = await preview();
  assert.equal(row.status, "error");
  assert.equal(row.serverId, null);
});

test("a team the cluster is not shared with gets no preview placed on it", async () => {
  // Team B's App is still on the cluster after the sharing was withdrawn.
  await seedApp(db, {
    id: "prj_b",
    slug: "theirs",
    teamId: TEAM_B,
    repo: null,
    serverId: "srv_2",
  });
  await db
    .update(appsTable)
    .set({ source: "docker-image", dockerImage: "nginx:1.27", clusterId })
    .where(eq(appsTable.id, "prj_b"));
  await seedPreview(db, {
    id: "prv_b",
    appId: "prj_b",
    prNumber: 3,
    status: "queued",
  });

  await assert.rejects(
    deployPreviewRow("prv_b", { actor: "Deplo" }),
    /^Error: That cluster isn't available to this team\.$/,
  );
  assert.equal(leader.asked.length, 0);
  assert.equal((await db.select().from(deploymentsTable)).length, 0);
  assert.equal((await preview("prv_b")).serverId, null);
});

test("a fork's preview on a cluster gets none of the App's secrets, its tunnel or a bundle", async () => {
  await withTunnel();
  const now = "2026-11-08T00:00:00.000Z";
  await db.insert(envVars).values({
    id: "env_1",
    appId: APP,
    key: "API_KEY",
    valueEnc: encryptSecret("s3cr3t-value"),
    type: "secret",
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(envVarTargets)
    .values({ envVarId: "env_1", target: "preview" });
  // The team's own pull request does get the value.
  assert.match(JSON.stringify(await deployPreview()), /s3cr3t-value/);
  await db
    .update(appPreviews)
    .set({ isFork: true, headRepo: "stranger/web", approvedSha: "" })
    .where(eq(appPreviews.id, PREVIEW));

  const req = await deployPreview();

  assert.equal(hosts.srv_3.deploys.length, 2);
  assert.doesNotMatch(
    JSON.stringify(req),
    /s3cr3t-value|API_KEY|tunnel-token|connector/,
  );
  assert.equal(req.network, `deplo-preview-${KEY}`);
  assert.equal(leader.held.size, 0);
  assert.equal((await db.select().from(failoverBundlePushes)).length, 0);
});

test("a generated address follows the preview to its member, and the next push keeps it there", async () => {
  await deployPreview();
  assert.equal((await preview()).host, hostOn("srv_3"));
  assert.match((await preview()).url, new RegExp(hostOn("srv_3")));

  // The leader would now pick another server; a preview that runs stays where it is.
  leader.place = "srv_4";
  await deployPreview();
  assert.equal(leader.asked.length, 1);
  assert.equal((await preview()).serverId, "srv_3");
  assert.equal(hosts.srv_4.deploys.length, 0);
  assert.deepEqual(hosts.srv_3.stack, []);
});

test("a preview whose server stopped reads Offline until it is redeployed, and the leader never moves it", async () => {
  await deployPreview();
  assert.equal(await statusRead(), "active");

  await fence("srv_3", 1, "not_responding");
  assert.equal(await statusRead(), "active");
  await fence("srv_3", 2);
  assert.equal(await statusRead(), "offline");
  assert.equal((await read()).offlineReason, "server_stopped");

  // A placement the leader reports for it is not a workload of the cluster: nothing is recorded or deployed.
  await applyLeaderEvent(clusterId, {
    seq: 3,
    type: "placement",
    cluster: clusterId,
    data: { kind: "app", workloadId: PREVIEW, members: ["srv_4"], epoch: 1 },
  });
  assert.equal((await preview()).serverId, "srv_3");
  assert.equal((await db.select().from(deploymentsTable)).length, 1);
  assert.equal(hosts.srv_4.deploys.length, 0);

  // The server answering again does not bring the preview back by itself.
  await fence("srv_3", 4, "ok");
  assert.equal(await statusRead(), "offline");

  // "Redeploy" places it again, here on another server; the copy left behind is removed once srv_3 is reachable.
  hosts.srv_3.unreachable = true;
  leader.place = "srv_4";
  const dto = await asAdmin(() => redeployPreview(PREVIEW));
  assert.equal(dto.status, "queued");
  assert.equal(leader.asked.length, 2);
  await runDeploymentGuarded(dto.latestDeploymentId!);
  assert.equal(hosts.srv_4.deploys.length, 1);
  assert.equal(hosts.srv_4.deploys[0]!.network, `deplo-preview-${KEY}`);
  const row = await preview();
  assert.equal(row.serverId, "srv_4");
  assert.equal(row.host, hostOn("srv_4"));
  assert.equal(await statusRead(), "active");
  assert.deepEqual(
    (await db.select().from(pendingTeardowns)).map((t) => [
      t.serverId,
      t.deployKey,
    ]),
    [["srv_3", KEY]],
  );
});

test("the next push places an offline preview again", async () => {
  await deployPreview();
  await fence("srv_3");
  await db
    .update(appsTable)
    .set({
      source: "github",
      repoProvider: "github",
      repoRepo: "acme/web",
      repoUrl: "https://github.com/acme/web",
      repoBranch: "main",
    })
    .where(eq(appsTable.id, APP));
  leader.place = "srv_2";

  const res = await openOrSyncPreview(
    APP,
    {
      number: 7,
      title: "Add dark mode",
      author: "octocat",
      url: "https://github.com/acme/web/pull/7",
      headBranch: "feat/pr-7",
      headSha: "abc1234",
      headRepo: "acme/web",
      headCloneUrl: "https://github.com/acme/web.git",
      baseBranch: "main",
      isFork: false,
    },
    { actor: "github" },
  );

  assert.equal((await deployment(res.deploymentId!)).serverId, "srv_2");
  const row = await preview();
  assert.equal(row.serverId, "srv_2");
  assert.equal(row.status, "queued");
  // The copy on the server that stopped is removed from it.
  assert.deepEqual(hosts.srv_3.stack, [`destroy:${KEY}`]);
  await cancelQueued();
});

// Team B's App, still on the cluster after the sharing was withdrawn.
async function teamBApp() {
  await seedApp(db, {
    id: "prj_b",
    slug: "theirs",
    teamId: TEAM_B,
    repo: null,
    serverId: "srv_2",
  });
  await db
    .update(appsTable)
    .set({ source: "docker-image", dockerImage: "nginx:1.27", clusterId })
    .where(eq(appsTable.id, "prj_b"));
}

test("the preview settings name the App's cluster, and only to a team that can see it", async () => {
  const mine = await asAdmin(() => listAppPreviews(APP));
  assert.equal(mine.serverId, null);
  assert.equal(mine.clusterId, clusterId);
  assert.equal(mine.clusterName, "eu");

  await teamBApp();
  const theirs = await asTeamB(() => listAppPreviews("prj_b"));
  assert.equal(theirs.clusterId, null);
  assert.equal(theirs.clusterName, null);
});

test("a member is never picked for previews, and a team that cannot see the cluster cannot move them onto it", async () => {
  await assert.rejects(
    asAdmin(() => setAppPreviewSettings(APP, { serverId: "srv_3" })),
    /^Error: That server is a member of cluster eu, so nothing can be placed on it directly\.$/,
  );

  await teamBApp();
  await db
    .update(appsTable)
    .set({ previewServerId: SERVER_1 })
    .where(eq(appsTable.id, "prj_b"));
  await assert.rejects(
    asTeamB(() => setAppPreviewSettings("prj_b", { serverId: "" })),
    /^Error: That cluster isn't available to this team\.$/,
  );
  const [theirs] = await db
    .select({ previewServerId: appsTable.previewServerId })
    .from(appsTable)
    .where(eq(appsTable.id, "prj_b"));
  assert.equal(theirs!.previewServerId, SERVER_1);
  // Another team's App is not theirs to change at all.
  await assert.rejects(
    asTeamB(() => setAppPreviewSettings(APP, { serverId: "" })),
    /App not found/,
  );

  // The team the cluster is shared with moves its previews back onto it.
  await db
    .update(appsTable)
    .set({ previewServerId: SERVER_1 })
    .where(eq(appsTable.id, APP));
  await asAdmin(() => setAppPreviewSettings(APP, { serverId: "" }));
  assert.equal((await asAdmin(() => listAppPreviews(APP))).serverId, null);
});

test("destroying a preview removes it from the member it runs on, not the App's", async () => {
  await deployPreview();
  assert.equal(await asAdmin(() => destroyPreview(PREVIEW)), true);
  assert.deepEqual(hosts.srv_3.stack, [`destroy:${KEY}`]);
  assert.deepEqual(hosts.srv_2.stack, []);
});

test("picking a server of their own takes previews off the cluster", async () => {
  await deployPreview();
  hosts[SERVER_1]!.capabilities.push(
    "deploy.network",
    "deploy.image",
    "deploy.railpack",
    "deploy.ready-check",
  );
  hosts[SERVER_1]!.extra = { listInstances: async () => [] };

  await asAdmin(() => setAppPreviewSettings(APP, { serverId: SERVER_1 }));
  // The one that ran on srv_3 was stopped there.
  assert.deepEqual(hosts.srv_3.stack, [`destroy:${KEY}`]);
  assert.equal((await preview()).status, "evicted");

  await asAdmin(() => redeployPreview(PREVIEW));
  assert.equal(leader.asked.length, 1);
  assert.equal((await preview()).serverId, SERVER_1);
  await cancelQueued();
});

const queuedOn = async () =>
  (await db.select().from(deploymentsTable))
    .filter((d) => d.status === "queued")
    .map((d) => [d.serverId, d.creator]);

const activity = async () =>
  (await db.select().from(activities)).map((a) => a.message);

test("emptying a member places the previews it runs on another member", async () => {
  await deployPreview();
  leader.place = "srv_4";

  await asAdmin(() => removeClusterMember(clusterId, "srv_3"));

  assert.equal(leader.asked.length, 2);
  assert.deepEqual(await queuedOn(), [["srv_4", "Deplo"]]);
  const row = await preview();
  assert.equal(row.serverId, "srv_4");
  assert.equal(row.host, hostOn("srv_4"));
  assert.deepEqual(hosts.srv_3.stack, [`destroy:${KEY}`]);
  await cancelQueued();
});

test("a preview no other member can take is taken down when its member is emptied, and Activity says so", async () => {
  await deployPreview();
  leader.refusal = { reason: "no_room", neededMb: 256 };

  await asAdmin(() => removeClusterMember(clusterId, "srv_3"));

  assert.deepEqual(hosts.srv_3.stack, [`destroy:${KEY}`]);
  assert.deepEqual(await queuedOn(), []);
  assert.equal(await statusRead(), "offline");
  assert.equal((await read()).offlineReason, "server_emptied");
  assert.ok(
    (await activity()).includes(
      "Took down the preview for pull request #7 of web on srv_3: No server in cluster eu has 256 MB free. Add a server to it or lower web's memory.",
    ),
  );
  // A redeploy places it once there is room again.
  leader.refusal = null;
  leader.place = "srv_4";
  await asAdmin(() => redeployPreview(PREVIEW));
  assert.equal((await preview()).serverId, "srv_4");
  assert.equal((await read()).offlineReason, null);
  await cancelQueued();
});

test("removing a member moves the previews it still ran", async () => {
  leader.place = "srv_4";
  await deployPreview();
  leader.place = "srv_3";

  await asAdmin(() => removeClusterMember(clusterId, "srv_4"));

  assert.deepEqual(await queuedOn(), [["srv_3", "Deplo"]]);
  assert.equal((await preview()).serverId, "srv_3");
  assert.deepEqual(hosts.srv_4.stack, [`destroy:${KEY}`]);
  await cancelQueued();
});

test("deleting the cluster leaves a preview where it runs, and a redeploy brings it to the App's server", async () => {
  await deployPreview();
  await asAdmin(() => deleteCluster(clusterId));

  const kept = await preview();
  assert.equal(kept.serverId, "srv_3");
  assert.equal(kept.status, "active");
  assert.deepEqual(hosts.srv_3.stack, []);

  await asAdmin(() => redeployPreview(PREVIEW));
  // No cluster is asked any more: it follows the App.
  assert.equal(leader.asked.length, 1);
  assert.deepEqual(await queuedOn(), [["srv_2", "user_1"]]);
  assert.equal((await preview()).serverId, "srv_2");
  assert.deepEqual(hosts.srv_3.stack, [`destroy:${KEY}`]);
  await cancelQueued();
});

test("the App moving to another member leaves its previews running where they are", async () => {
  await deployPreview();
  leader.place = "srv_4";

  await asAdmin(() => removeClusterMember(clusterId, "srv_2"));
  await runEmptyingPass();

  const [app] = await db
    .select({ serverId: appsTable.serverId })
    .from(appsTable)
    .where(eq(appsTable.id, APP));
  assert.equal(app!.serverId, "srv_4");
  const row = await preview();
  assert.equal(row.status, "active");
  assert.equal(row.serverId, "srv_3");
  assert.equal(row.host, hostOn("srv_3"));
  assert.deepEqual(hosts.srv_3.stack, []);
  await cancelQueued();
});

test("removing a member's server outright leaves its previews offline, not running on a server that is gone", async () => {
  leader.place = "srv_4";
  await deployPreview();

  await asAdmin(() => removeServer("srv_4"));
  assert.equal(await statusRead(), "offline");
  assert.equal((await preview()).serverId, null);

  leader.place = "srv_3";
  await asAdmin(() => redeployPreview(PREVIEW));
  assert.equal((await preview()).serverId, "srv_3");
  await cancelQueued();
});

test("the image a preview was built into is not copied to the other members", async () => {
  await seedDeployment(db, {
    id: "dpl_built",
    appId: APP,
    previewId: PREVIEW,
    prNumber: 7,
    environment: "preview",
    deployKey: KEY,
    serverId: "srv_3",
    imageRef: `deplo/${KEY}:dpl_built`,
  });
  // The deploy's tail, as a ready deploy calls it.
  copyImageAfterDeploy("dpl_built", "srv_3");
  await new Promise((r) => setTimeout(r, 150));
  for (const id of MEMBERS) assert.deepEqual(hosts[id]!.imageCopies, []);
  assert.deepEqual(await db.select().from(clusterImageCopies), []);
});
