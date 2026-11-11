import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedDeployment,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import {
  clusterLeaderKeys,
  failoverBundlePushes,
} from "../db/schema/control-plane/clusters";
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
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { ensureClusterLeader, getClusterLeader } from "./clusters/leader";
import { forgetLeaderRoster } from "./clusters/leader-sync";
import { moveClusterLeader } from "./clusters/leader-move";
import { getClusterById } from "./clusters/roster";
import {
  flushFailoverBundles,
  keyFingerprint,
  pushFailoverBundle,
} from "./clusters/bundles";
import { createApp } from "./apps/create";
import { invalidateFrozen } from "./deplo-move/freeze";
import {
  newTestLeader,
  openBundle,
  type TestLeader,
} from "./cluster-leader-test-helpers";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const everyone = { allTeams: true, teamIds: [] as string[] };
const SERVERS = ["srv_2", "srv_3", "srv_4"];

let hosts: Record<string, FakeClusterHost> = {};
let leaders: Record<string, TestLeader> = {};

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
    truncate table clusters, failover_bundle_pushes, activities, deplo_moves, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  for (const [i, id] of SERVERS.entries()) {
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
  fleet = fakeClusterHosts();
  hosts = {};
  leaders = {};
  for (const id of [SERVER_1, ...SERVERS]) {
    const l = (leaders[id] = await newTestLeader());
    hosts[id] = fleet.host(id, {
      leader: l.calls,
      ...(id === SERVER_1 ? { status: RUNNING } : {}),
    });
  }
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  forgetLeaderRoster();
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
const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

async function eu() {
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
  return cluster;
}

const messages = async (teamId = TEAM_A) =>
  (
    await db
      .select()
      .from(activities)
      .where(eq(activities.teamId, teamId))
      .orderBy(activities.seq)
  ).map((a) => `${a.actor}: ${a.message}`);

test("moving the leader installs it on the picked server, which leads from the next epoch", async () => {
  const cluster = await eu();

  const moved = await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));

  assert.equal(moved.leaderServerId, "srv_4");
  assert.equal(hosts.srv_4.installs.length, 1);
  assert.equal(hosts.srv_4.installs[0].version, "0.2.0");
  // Deplo's own machine led at epoch 1; the new leader is never handed the same one.
  assert.equal(moved.leaderEpoch, 2);
  const roster = leaders.srv_4.rosters.at(-1)!;
  assert.equal(roster.epoch, 2);
  assert.deepEqual(
    roster.members.map((m) => m.id),
    ["srv_2", "srv_3"],
  );
  assert.equal((await getClusterById(cluster.id))!.leaderEpoch, 2);

  const leader = await asAdmin(() => getClusterLeader(cluster.id));
  assert.equal(leader.serverId, "srv_4");
  assert.equal(leader.serverName, "srv_4");
  assert.equal(leader.onDeploHost, false);
  assert.equal(leader.state, "running");
  assert.equal(leader.takenOverAt, null);

  assert.ok(
    (await messages()).includes(
      `${USER_1}: Moved the leader of cluster eu to srv_4`,
    ),
    (await messages()).join("\n"),
  );
});

test("only an instance admin moves a leader, whichever team asks", async () => {
  const cluster = await eu();
  await assert.rejects(
    asTeamB(() => moveClusterLeader(cluster.id, "srv_4")),
    /instance admin/i,
  );
  assert.equal((await getClusterById(cluster.id))!.leaderServerId, null);
  assert.equal(hosts.srv_4.installs.length, 0);
  assert.deepEqual(await messages(TEAM_B), []);
});

const TRAEFIK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
networks:
  deplo:
    external: true
`;

const relayRosters = (h: FakeClusterHost) =>
  h.calls
    .filter((c) => c.method === "relay.roster")
    .map(
      (c) =>
        JSON.parse(new TextDecoder().decode(c.payload)) as {
          cluster: string;
          parties: { fingerprint: string; role: string }[];
        },
    );

test("a server that answers on 443 runs a relay beside the leader, and every member is told to dial it", async () => {
  const cluster = await eu();
  hosts.srv_4.proxy.yaml = TRAEFIK;

  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));

  assert.equal(hosts.srv_4.installs.at(-1)!.relay, true);
  assert.equal(hosts.srv_4.proxy.applied, 1);
  assert.match(
    hosts.srv_4.proxy.yaml,
    /Host\(`10\.0\.0\.4`\) && Path\(`\/api\/cluster\/relay`\)/,
  );
  assert.match(hosts.srv_4.proxy.yaml, /host\.docker\.internal:host-gateway/);

  // Both leaders may lead, so both relays let both through.
  const parties = [
    { fingerprint: "4".repeat(64), role: "leader" },
    { fingerprint: "1".repeat(64), role: "leader" },
    { fingerprint: "2".repeat(64), role: "member" },
    { fingerprint: "3".repeat(64), role: "member" },
  ];
  assert.deepEqual(relayRosters(hosts.srv_4).at(-1), {
    cluster: cluster.id,
    parties,
  });
  assert.deepEqual(relayRosters(hosts[SERVER_1]).at(-1), {
    cluster: cluster.id,
    parties,
  });
  for (const id of ["srv_2", "srv_3"])
    assert.deepEqual(hosts[id].memberCalls.at(-1), {
      member: true,
      relays: ["https://10.0.0.4"],
    });
});

test("a server with no proxy runs the leader alone", async () => {
  const cluster = await eu();
  await db
    .update(serversTable)
    .set({ traefikEnabled: false })
    .where(eq(serversTable.id, "srv_4"));

  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));

  assert.equal(hosts.srv_4.installs.at(-1)!.relay, false);
  assert.equal(hosts.srv_4.proxy.applied, 0);
  assert.deepEqual(relayRosters(hosts.srv_4), []);
  assert.deepEqual(hosts.srv_2.memberCalls.at(-1), {
    member: true,
    relays: [],
  });
});

test("moving the leader back to Deplo's machine takes the old one, its relay and its door away", async () => {
  const cluster = await eu();
  hosts.srv_4.proxy.yaml = TRAEFIK;
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));

  // Picked by its own server entry: stored as Deplo's machine all the same.
  const back = await asAdmin(() => moveClusterLeader(cluster.id, SERVER_1));

  assert.equal(back.leaderServerId, null);
  assert.equal(back.leaderEpoch, 3);
  assert.equal(leaders[SERVER_1].rosters.at(-1)!.epoch, 3);
  assert.equal(hosts.srv_4.removes, 1);
  assert.doesNotMatch(hosts.srv_4.proxy.yaml, /cluster\/relay/);
  assert.doesNotMatch(hosts.srv_4.proxy.yaml, /host-gateway/);
  assert.deepEqual(hosts.srv_2.memberCalls.at(-1), {
    member: true,
    relays: [],
  });
  assert.deepEqual(
    relayRosters(hosts[SERVER_1])
      .at(-1)!
      .parties.map((p) => p.role),
    ["leader", "member", "member"],
  );
  assert.ok(
    (await messages()).includes(
      `${USER_1}: Moved the leader of cluster eu to ${SERVER_1}`,
    ),
  );
});

test("a leader another cluster still uses stays on its server", async () => {
  const eu1 = await eu();
  const us = await asAdmin(() => createCluster("us", everyone));
  await asAdmin(() => moveClusterLeader(eu1.id, "srv_4"));
  await asAdmin(() => moveClusterLeader(us.id, "srv_4"));

  await asAdmin(() => moveClusterLeader(eu1.id, null));

  assert.equal(hosts.srv_4.removes, 0);
  assert.equal((await getClusterById(us.id))!.leaderServerId, "srv_4");
});

test("a server that cannot run a leader is refused in words, and nothing changes", async () => {
  const cluster = await eu();
  hosts.srv_4.unreachable = true;
  await assert.rejects(
    asAdmin(() => moveClusterLeader(cluster.id, "srv_4")),
    /^Error: srv_4 is offline, so the leader cannot run on it\.$/,
  );
  hosts.srv_4.unreachable = false;
  hosts.srv_4.capabilities = ["hostops"];
  await assert.rejects(
    asAdmin(() => moveClusterLeader(cluster.id, "srv_4")),
    /agent/i,
  );
  await assert.rejects(
    asAdmin(() => moveClusterLeader(cluster.id, "srv_nope")),
    /Server not found/,
  );
  await assert.rejects(
    asAdmin(() => moveClusterLeader("clu_nope", "srv_4")),
    /Cluster not found/,
  );
  const now = (await getClusterById(cluster.id))!;
  assert.equal(now.leaderServerId, null);
  assert.equal(now.leaderEpoch, cluster.leaderEpoch);
  assert.equal(hosts.srv_4.installs.length, 0);
});

const COMPOSE =
  'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "80"\n';

async function clusterApp(clusterId: string) {
  return asAdmin(() =>
    createApp({
      name: "web",
      source: "compose",
      repo: null,
      compose: COMPOSE,
      deploy: false,
      clusterId,
    }),
  );
}

// What a successful deploy leaves behind: a ready deployment and its bundle at every leader.
async function deployed(app: { id: string; slug: string }, deployId: string) {
  await seedDeployment(db, { id: deployId, appId: app.id, status: "ready" });
  await pushFailoverBundle({
    appId: app.id,
    deploymentId: deployId,
    stack: {
      slug: app.slug,
      projectId: app.id,
      imageRef: "nginx:1.27",
      composeYaml: COMPOSE,
      network: "deplo-team-x",
      env: { API_KEY: "k-123" },
      registryAuth: [],
      composeUpArgs: [],
    },
  });
}

const keyOwners = async (clusterId: string) =>
  Object.fromEntries(
    (
      await db
        .select()
        .from(clusterLeaderKeys)
        .where(eq(clusterLeaderKeys.clusterId, clusterId))
    ).map((k) => [k.serverId ?? "deplo", k.publicKey]),
  );

const pushedTo = async (appId: string) =>
  (
    await db
      .select()
      .from(failoverBundlePushes)
      .where(eq(failoverBundlePushes.workloadId, appId))
  )
    .filter((r) => r.pushedAt)
    .map((r) => r.keyFingerprint)
    .sort();

test("both leaders may lead, so every bundle is sealed to both keys and each opens its own", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await deployed(app, "dpl_1");
  const own = leaders[SERVER_1];
  assert.equal((await openBundle(own, app.id)).deploymentId, "dpl_1");

  // The move alone sends what is live to the new leader, sealed to its key.
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  const remote = leaders.srv_4;
  assert.deepEqual(await keyOwners(cluster.id), {
    srv_4: remote.publicKey,
    deplo: own.publicKey,
  });
  for (const l of [remote, own]) {
    const bundle = await openBundle(l, app.id);
    assert.equal(bundle.deploymentId, "dpl_1");
    assert.equal(bundle.stack.env.API_KEY, "k-123");
  }
  // Two ciphertexts: neither leader can open the other's copy.
  await assert.rejects(openBundle({ ...own, held: remote.held }, app.id));
  await assert.rejects(openBundle({ ...remote, held: own.held }, app.id));

  // The next deploy goes to both again.
  await deployed(app, "dpl_2");
  for (const l of [remote, own])
    assert.equal((await openBundle(l, app.id)).deploymentId, "dpl_2");
  assert.deepEqual(
    await pushedTo(app.id),
    [remote, own].map((l) => keyFingerprint(l.publicKey)).sort(),
  );
});

test("moving the leader to a third server, then back, retires the old key each time", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await deployed(app, "dpl_1");
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));

  await asAdmin(() => moveClusterLeader(cluster.id, "srv_3"));
  assert.deepEqual(await keyOwners(cluster.id), {
    srv_3: leaders.srv_3.publicKey,
    deplo: leaders[SERVER_1].publicKey,
  });
  assert.equal((await openBundle(leaders.srv_3, app.id)).deploymentId, "dpl_1");
  assert.deepEqual(
    await pushedTo(app.id),
    [leaders.srv_3, leaders[SERVER_1]]
      .map((l) => keyFingerprint(l.publicKey))
      .sort(),
  );

  await asAdmin(() => moveClusterLeader(cluster.id, null));
  assert.deepEqual(await keyOwners(cluster.id), {
    deplo: leaders[SERVER_1].publicKey,
  });
  assert.deepEqual(await pushedTo(app.id), [
    keyFingerprint(leaders[SERVER_1].publicKey),
  ]);
});

test("a leader that still leads another cluster drops the bundles of the one it lost", async () => {
  const cluster = await eu();
  const us = await asAdmin(() => createCluster("us", everyone));
  const app = await clusterApp(cluster.id);
  await deployed(app, "dpl_1");
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  await asAdmin(() => moveClusterLeader(us.id, "srv_4"));
  assert.ok(leaders.srv_4.held.has(app.id));

  await asAdmin(() => moveClusterLeader(cluster.id, null));

  assert.equal(leaders.srv_4.held.has(app.id), false);
  assert.equal(hosts.srv_4.removes, 0);
});

test("starting a stopped leader again on its server keeps the relay beside it", async () => {
  const cluster = await eu();
  hosts.srv_4.proxy.yaml = TRAEFIK;
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  hosts.srv_4.status = { ...hosts.srv_4.status, running: false };
  assert.equal(
    (await asAdmin(() => getClusterLeader(cluster.id))).state,
    "stopped",
  );

  const leader = await asAdmin(() => ensureClusterLeader(cluster.id));

  assert.equal(leader.serverId, "srv_4");
  assert.equal(leader.state, "running");
  assert.equal(hosts.srv_4.installs.at(-1)!.relay, true);
});
