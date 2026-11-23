import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import type { TestDb } from "../db/test-harness";
import {
  clusterNetworkLinks,
  clusterWarnings,
} from "../db/schema/control-plane/clusters";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { nowIso } from "../ids";
import { __forgetMemberProbes } from "../infra/agent-client/cluster-host";
import type { FakeClusterHost } from "../infra/agent-client/cluster-test-helpers";
import { CLUSTER_SUCCESSION_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { SERVER_1 } from "./app-graph-test-helpers";
import { HelloResponse } from "../agent/gen/agent";
import { keepLeadersHome, placeClusterLeaders } from "./clusters/leader-move";
import { superviseClusterLeader } from "./clusters/leader-standby";
import {
  __setLeaderBeatClockForTest,
  beatClusterLeaders,
  TAKEOVER_AFTER_MS,
} from "./clusters/leader-beat";
import { forgetLeaderRoster, pushLeaderRoster } from "./clusters/leader-sync";
import { listClusterMembers } from "./clusters/members";
import { getClusterById } from "./clusters/roster";
import { __forgetHeirsForTest, clusterHeirs } from "./clusters/succession";
import { refreshClusterWarnings } from "./clusters/warnings";
import {
  leaderLab,
  relayRosters,
  type TestLeader,
} from "./cluster-leader-test-helpers";

const lab = leaderLab();
const { asAdmin, eu, messages, stored } = lab;

let db: TestDb;
let hosts: Record<string, FakeClusterHost>;
let leaders: Record<string, TestLeader>;
beforeEach(() => {
  ({ db, hosts, leaders } = lab);
  __forgetMemberProbes();
  __forgetHeirsForTest();
});

const dec = new TextDecoder();

/** Every pair of the given servers reports this path, both ways. */
async function paths(
  clusterId: string,
  ids: string[],
  path: (a: string, b: string) => "direct" | "relay",
) {
  await db.delete(clusterNetworkLinks);
  for (const a of ids)
    for (const b of ids)
      if (a !== b)
        await db.insert(clusterNetworkLinks).values({
          clusterId,
          serverId: a,
          peerServerId: b,
          path: path(a, b),
          checkedAt: nowIso(),
        });
}

const direct = () => "direct" as const;

/** Cluster eu on srv_2, srv_3 and srv_4, every pair direct, every agent able to pre-vote. */
async function three() {
  const cluster = await eu();
  const { addClusterMember } = await import("./clusters/members");
  await asAdmin(() => addClusterMember(cluster.id, "srv_4"));
  for (const id of ["srv_2", "srv_3", "srv_4"])
    hosts[id].capabilities.push(CLUSTER_SUCCESSION_CAPABILITY);
  __forgetMemberProbes();
  await paths(cluster.id, ["srv_2", "srv_3", "srv_4"], direct);
  return cluster;
}

/** The leader on a server answers its snapshot with this cluster led at `epoch`. */
function leading(h: FakeClusterHost, clusterId: string, epoch: number) {
  const calls = h.leader;
  h.leader = (method, payload) =>
    method === "leader.snapshot"
      ? new TextEncoder().encode(
          JSON.stringify({
            head: 7,
            clusters: {
              [clusterId]: { epoch, leads: true, superseded: false },
            },
          }),
        )
      : calls(method, payload);
}

test("a cluster led from Deplo's machine gets its leader on the member with the most room", async () => {
  const cluster = await three();
  await db
    .update(serversTable)
    .set({ memoryMb: 16384 })
    .where(eq(serversTable.id, "srv_3"));
  await placeClusterLeaders();
  const after = await stored(cluster.id);
  assert.equal(after.server, "srv_3");
  assert.equal(after.takenOver, false);
  assert.ok(after.epoch > cluster.leaderEpoch);
  assert.ok(hosts.srv_3.installs.length > 0, "the leader was installed there");
  assert.match(
    (await messages()).join("\n"),
    /The leader of cluster eu now runs on srv_3, one of its own servers/,
  );
  // Once inside, it stays: the next pass moves nothing.
  await placeClusterLeaders();
  assert.equal((await stored(cluster.id)).epoch, after.epoch);
});

test("no leader moves onto a member before a direct path between members is known", async () => {
  const cluster = await eu();
  await placeClusterLeaders();
  assert.equal((await stored(cluster.id)).server, null);
});

test("the line: the leader names its heirs, they hold a standby roster, a leader each and every member takes their orders", async () => {
  const cluster = await three();
  await placeClusterLeaders();
  const led = (await getClusterById(cluster.id))!;
  const heirs = await clusterHeirs(led);
  assert.equal(heirs.length, 2);
  assert.ok(!heirs.includes(led.leaderServerId!));

  await keepLeadersHome([cluster.id]);
  forgetLeaderRoster(cluster.id);
  await pushLeaderRoster(led);
  const roster = leaders[led.leaderServerId!].rosters.at(-1) as unknown as {
    self: string;
    deplo: string;
    heirs: string[];
    members: { id: string; succession?: boolean }[];
  };
  assert.equal(roster.self, led.leaderServerId);
  assert.equal(roster.deplo, SERVER_1);
  assert.deepEqual(roster.heirs, heirs);
  assert.ok(roster.members.every((m) => m.succession));
  for (const heir of heirs) {
    const standby = hosts[heir].calls.filter(
      (c) => c.method === "leader.standby",
    );
    assert.ok(standby.length > 0, `${heir} holds no standby roster`);
    assert.equal(
      (JSON.parse(dec.decode(standby.at(-1)!.payload)) as { self: string })
        .self,
      heir,
    );
    assert.ok(hosts[heir].installs.length > 0, `${heir} runs no leader`);
  }
  // Every heir's certificate is a leader the relay and the members accept.
  const parties = relayRosters(hosts[SERVER_1]).at(-1)!.parties;
  for (const heir of heirs) {
    const [row] = await db
      .select({ fp: serversTable.agentCertFingerprint })
      .from(serversTable)
      .where(eq(serversTable.id, heir));
    assert.ok(
      parties.some((p) => p.role === "leader" && p.fingerprint === row.fp),
      `${heir} is not a leader of the relay roster`,
    );
  }
});

test("no line while one member's agent cannot pre-vote", async () => {
  const cluster = await three();
  hosts.srv_4.capabilities = hosts.srv_4.capabilities.filter(
    (c) => c !== CLUSTER_SUCCESSION_CAPABILITY,
  );
  __forgetMemberProbes();
  assert.deepEqual(await clusterHeirs((await getClusterById(cluster.id))!), []);
});

test("an heir that took the cluster over without Deplo is adopted at its own epoch", async () => {
  const cluster = await three();
  await placeClusterLeaders();
  const led = (await getClusterById(cluster.id))!;
  const [heir] = await clusterHeirs(led);
  const old = led.leaderServerId!;
  hosts[old].unreachable = true;
  hosts[heir].status = {
    installed: true,
    running: true,
    version: "0.2.0",
    relay: false,
    member: true,
    relayLinks: 0,
  };
  leading(hosts[heir], cluster.id, led.leaderEpoch + 1);

  assert.equal(await superviseClusterLeader(cluster.id), "succeeded");
  const now = await stored(cluster.id);
  assert.deepEqual(now, {
    server: heir,
    takenOver: false,
    epoch: led.leaderEpoch + 1,
  });
  assert.equal((await getClusterById(cluster.id))!.eventSeq, 7);
  assert.match(
    (await messages()).join("\n"),
    new RegExp(
      `${old} stopped answering its servers, so ${heir}, next in line, leads cluster eu`,
    ),
  );
  // Deplo's machine never stood in.
  assert.equal(await superviseClusterLeader(cluster.id), null);
  assert.equal((await stored(cluster.id)).takenOver, false);
});

/** The leader on a server answers its snapshot as one trying to lead the cluster at `epoch`, no quorum yet. */
function trying(h: FakeClusterHost, clusterId: string, epoch: number) {
  const calls = h.leader;
  h.leader = (method, payload) =>
    method === "leader.snapshot"
      ? new TextEncoder().encode(
          JSON.stringify({
            head: 9,
            clusters: { [clusterId]: { epoch, leads: false, succeed: true } },
          }),
        )
      : calls(method, payload);
}

const runs = {
  installed: true,
  running: true,
  version: "0.2.0",
  relay: false,
  member: true,
  relayLinks: 0,
};

/** Every epoch the leader on a host was named, in order. */
const beatsTo = (h: FakeClusterHost) =>
  h.calls
    .filter((c) => c.method === "leader.beat")
    .map(
      (c) => (JSON.parse(dec.decode(c.payload)) as { epochs: object }).epochs,
    );

test("with half of the servers left, Deplo gives its word to the next in line, and its machine does not stand in", async () => {
  const cluster = await three();
  await placeClusterLeaders();
  const led = (await getClusterById(cluster.id))!;
  const [first, second] = await clusterHeirs(led);
  let now = 1_000_000;
  __setLeaderBeatClockForTest(() => now);
  try {
    // The leader's server and the first heir's are off: the second heir asks to lead at the epoch its line gives it.
    hosts[led.leaderServerId!].unreachable = true;
    hosts[first].unreachable = true;
    hosts[second].status = runs;
    const epoch = led.leaderEpoch + 2;
    trying(hosts[second], cluster.id, epoch);
    now += TAKEOVER_AFTER_MS;
    for (let i = 0; i < 3; i++)
      assert.equal(await superviseClusterLeader(cluster.id), null);
    assert.equal((await stored(cluster.id)).takenOver, false, "no stand-in");
    assert.match(
      (await messages()).join("\n"),
      new RegExp(
        `${led.leaderServerId} stopped answering, so Deplo gives its word to ${second}, next in line, to lead cluster eu`,
      ),
    );
    hosts[SERVER_1].calls.length = 0;
    await beatClusterLeaders();
    assert.deepEqual(beatsTo(hosts[second]), [{ [cluster.id]: epoch }]);
    assert.deepEqual(
      beatsTo(hosts[SERVER_1]),
      [],
      "Deplo's machine is named nothing",
    );

    // On that word a quorum took its epoch: Deplo adopts it, and goes on naming it there.
    leading(hosts[second], cluster.id, epoch);
    assert.equal(await superviseClusterLeader(cluster.id), "succeeded");
    assert.deepEqual(await stored(cluster.id), {
      server: second,
      takenOver: false,
      epoch,
    });
    hosts[second].calls.length = 0;
    await beatClusterLeaders();
    assert.deepEqual(beatsTo(hosts[second]), [{ [cluster.id]: epoch }]);
  } finally {
    __setLeaderBeatClockForTest(null);
  }
});

test("Deplo's machine stands in only when nobody in the line answers it", async () => {
  const cluster = await three();
  await placeClusterLeaders();
  const led = (await getClusterById(cluster.id))!;
  const heirs = await clusterHeirs(led);
  let now = 1_000_000;
  __setLeaderBeatClockForTest(() => now);
  try {
    hosts[led.leaderServerId!].unreachable = true;
    // The heirs answer Deplo but do not ask to lead: their leader may still renew them.
    for (const h of heirs) hosts[h].status = runs;
    now += TAKEOVER_AFTER_MS;
    for (let i = 0; i < 3; i++)
      assert.equal(await superviseClusterLeader(cluster.id), null);
    assert.equal((await stored(cluster.id)).takenOver, false);

    for (const h of heirs) hosts[h].unreachable = true;
    assert.equal(await superviseClusterLeader(cluster.id), "taken_over");
  } finally {
    __setLeaderBeatClockForTest(null);
  }
});

test("a relayed server gets the warning on itself, and a cluster with no direct majority is not OK for production", async () => {
  const cluster = await three();
  const relayed = (a: string, b: string) =>
    a === "srv_4" || b === "srv_4" ? ("relay" as const) : ("direct" as const);
  await paths(cluster.id, ["srv_2", "srv_3", "srv_4"], relayed);
  const members = await asAdmin(() => listClusterMembers(cluster.id));
  const warned = members.filter((m) => m.relayWarning).map((m) => m.serverId);
  assert.deepEqual(warned, ["srv_4"]);
  assert.match(
    members.find((m) => m.serverId === "srv_4")!.relayWarning,
    /only through Deplo's relay\. If Deplo's machine stops, srv_4 stops as if its power were cut/,
  );
  await refreshClusterWarnings((await getClusterById(cluster.id))!);
  const keys = async () =>
    (
      await db
        .select({ key: clusterWarnings.key })
        .from(clusterWarnings)
        .where(eq(clusterWarnings.clusterId, cluster.id))
    ).map((w) => w.key);
  assert.ok(!(await keys()).includes("not_for_production"));

  await paths(cluster.id, ["srv_2", "srv_3", "srv_4"], () => "relay");
  await refreshClusterWarnings((await getClusterById(cluster.id))!);
  assert.ok((await keys()).includes("not_for_production"));
  await refreshClusterWarnings((await getClusterById(cluster.id))!);

  await paths(cluster.id, ["srv_2", "srv_3", "srv_4"], direct);
  await refreshClusterWarnings((await getClusterById(cluster.id))!);
  assert.ok(!(await keys()).includes("not_for_production"));
  const said = (await messages()).filter((m) => /OK for production/.test(m));
  assert.deepEqual(said, [
    "Deplo: Cluster eu is not OK for production: fewer than half of its servers reach each other directly, so if Deplo's machine stops, every App and database of it stops",
    "Deplo: Cluster eu is OK for production again: more than half of its servers reach each other directly",
  ]);
  assert.deepEqual(
    (await asAdmin(() => listClusterMembers(cluster.id))).map(
      (m) => m.relayWarning,
    ),
    ["", "", ""],
  );
});

test("no leader moves onto a member whose agent is behind the pin", async () => {
  const cluster = await three();
  for (const id of ["srv_2", "srv_3", "srv_4"])
    hosts[id].extra = {
      hello: async () =>
        HelloResponse.fromPartial({
          agentVersion: "0.0.1",
          capabilities: hosts[id].capabilities,
          dockerAvailable: true,
        }),
    };
  await placeClusterLeaders();
  assert.equal((await stored(cluster.id)).server, null);
});

test("a leader whose server leaves the direct majority moves to one inside it", async () => {
  const cluster = await three();
  await placeClusterLeaders();
  const led = (await getClusterById(cluster.id))!;
  const on = led.leaderServerId!;
  // Its server now reaches the other two only through Deplo's relay.
  await paths(cluster.id, ["srv_2", "srv_3", "srv_4"], (a, b) =>
    a === on || b === on ? "relay" : "direct",
  );
  await placeClusterLeaders();
  const now = await stored(cluster.id);
  assert.notEqual(now.server, on);
  assert.ok(now.epoch > led.leaderEpoch);
  assert.match(
    (await messages()).join("\n"),
    new RegExp(
      `now runs on ${now.server}: ${on} reaches some of its servers only through Deplo's relay`,
    ),
  );
  // Every pair relayed: no direct majority to move into, so it stays.
  await paths(cluster.id, ["srv_2", "srv_3", "srv_4"], () => "relay");
  const before = (await stored(cluster.id)).epoch;
  await placeClusterLeaders();
  assert.equal((await stored(cluster.id)).epoch, before);
});
