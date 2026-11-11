import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import type { TestDb } from "../db/test-harness";
import { TEAM_B, USER_1 } from "./identity-test-helpers";
import { SERVER_1 } from "./app-graph-test-helpers";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import type { FakeClusterHost } from "../infra/agent-client/cluster-test-helpers";
import { createCluster } from "./clusters/manage";
import { ensureClusterLeader, getClusterLeader } from "./clusters/leader";
import {
  listClusterLeaderChoices,
  moveClusterLeader,
  reconcileRetiredLeaders,
} from "./clusters/leader-move";
import { getClusterById } from "./clusters/roster";
import { keyFingerprint } from "./clusters/bundles";
import {
  leaderLab,
  openBundle,
  relayRosters,
  TRAEFIK,
  type TestLeader,
} from "./cluster-leader-test-helpers";

const lab = leaderLab();
const { asAdmin, asTeamB, eu, messages, clusterApp, deployed } = lab;
const { keyOwners, pushedTo } = lab;
const everyone = { allTeams: true, teamIds: [] as string[] };

let db: TestDb;
let hosts: Record<string, FakeClusterHost>;
let leaders: Record<string, TestLeader>;
beforeEach(() => {
  ({ db, hosts, leaders } = lab);
});

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

test("the picker offers every server, Deplo's own machine first, and says which one cannot take the leader", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_3"));
  await db
    .update(serversTable)
    .set({ status: "offline" })
    .where(eq(serversTable.id, "srv_4"));

  const choices = await asAdmin(() => listClusterLeaderChoices(cluster.id));

  assert.deepEqual(choices, [
    {
      serverId: SERVER_1,
      serverName: SERVER_1,
      onDeploHost: true,
      current: false,
      blocked: "",
      note: "",
    },
    {
      serverId: "srv_2",
      serverName: "srv_2",
      onDeploHost: false,
      current: false,
      blocked: "",
      note: "",
    },
    {
      serverId: "srv_3",
      serverName: "srv_3",
      onDeploHost: false,
      current: true,
      blocked: "",
      note: "",
    },
    {
      serverId: "srv_4",
      serverName: "srv_4",
      onDeploHost: false,
      current: false,
      blocked: "srv_4 is offline. Bring it back online first.",
      note: "",
    },
  ]);

  // A server with no proxy can lead, and the picker says what that leader depends on.
  await db
    .update(serversTable)
    .set({ traefikEnabled: false })
    .where(eq(serversTable.id, "srv_2"));
  const bare = await asAdmin(() => listClusterLeaderChoices(cluster.id));
  assert.deepEqual(
    bare.map((c) => c.note),
    [
      "",
      "srv_2 has no proxy, so a leader there still needs Deplo's machine up to move anything.",
      "",
      "",
    ],
  );
  await assert.rejects(
    asTeamB(() => listClusterLeaderChoices(cluster.id)),
    /instance admin/i,
  );
});

test("a leader left on a server that did not answer is taken away once it answers", async () => {
  const cluster = await eu();
  hosts.srv_4.proxy.yaml = TRAEFIK;
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  hosts.srv_4.unreachable = true;

  await asAdmin(() => moveClusterLeader(cluster.id, null));
  assert.equal(hosts.srv_4.removes, 0, "it could not be asked");
  await reconcileRetiredLeaders();
  assert.equal(hosts.srv_4.removes, 0, "still away");

  hosts.srv_4.unreachable = false;
  await reconcileRetiredLeaders();
  assert.equal(hosts.srv_4.removes, 1);
  assert.doesNotMatch(hosts.srv_4.proxy.yaml, /cluster\/relay/);
  await reconcileRetiredLeaders();
  assert.equal(hosts.srv_4.removes, 1, "asked once");
});

test("a server that leads again before it could be asked keeps its leader", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  hosts.srv_4.unreachable = true;
  await asAdmin(() => moveClusterLeader(cluster.id, null));
  hosts.srv_4.unreachable = false;
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));

  await reconcileRetiredLeaders();

  assert.equal(hosts.srv_4.removes, 0);
});
