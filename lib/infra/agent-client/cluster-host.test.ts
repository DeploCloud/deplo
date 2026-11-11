import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __resetReleaseCacheForTests } from "../../agent/release";
import {
  __setClusterPinForTest,
  callClusterLeader,
  callClusterRelay,
  clusterLeaderStatus,
  setClusterMember,
  installClusterLeader,
  removeClusterLeader,
} from "./cluster-host";
import {
  AgentClusterMemberUnsupportedError,
  AgentClusterUnsupportedError,
  CLUSTER_HOST_UNSUPPORTED_MESSAGE,
  CLUSTER_MEMBER_UNSUPPORTED_MESSAGE,
  ClusterLeaderTooOldError,
  ClusterReleaseUnavailableError,
} from "./errors";
import { fakeClusterHosts } from "./cluster-test-helpers";

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const BASE =
  "https://github.com/DeploCloud/deplo-cluster/releases/download/v0.2.0";

let fleet: ReturnType<typeof fakeClusterHosts>;
let origFetch: typeof fetch;
let fetched: string[];

const leaderAt = (version: string, running = true) => ({
  installed: true,
  running,
  version,
  relay: false,
  member: false,
  relayLinks: 0,
});

beforeEach(() => {
  fleet = fakeClusterHosts();
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  fetched = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(SUMS);
  }) as typeof fetch;
});

afterEach(() => {
  fleet.restore();
  __setClusterPinForTest(null);
  __resetReleaseCacheForTests();
  globalThis.fetch = origFetch;
});

test("installs the pinned release, checksummed from its own repo, through the server's agent", async () => {
  const host = fleet.host("srv_a");
  const r = await installClusterLeader("srv_a", { relay: true });
  assert.deepEqual(r, { version: "0.2.0", running: true });
  assert.deepEqual(fetched, [`${BASE}/checksums.txt`]);
  assert.deepEqual(host.installs, [
    {
      version: "0.2.0",
      relay: true,
      urls: [
        `${BASE}/deplo-cluster-linux-amd64`,
        `${BASE}/deplo-cluster-linux-arm64`,
      ],
    },
  ]);
  assert.ok(host.opened.length > 0 && host.opened.every((s) => s === "srv_a"));
  assert.equal(host.closed, 1);
});

test("with no cluster release pinned nothing is installed and no agent is reached", async () => {
  const host = fleet.host("srv_a");
  __setClusterPinForTest({ version: "", min: "" });
  await assert.rejects(
    installClusterLeader("srv_a"),
    ClusterReleaseUnavailableError,
  );
  assert.deepEqual(host.opened, []);
});

test("a release that cannot be downloaded is named before the agent is reached", async () => {
  const host = fleet.host("srv_a");
  globalThis.fetch = (async () =>
    new Response("nope", { status: 404 })) as typeof fetch;
  await assert.rejects(
    installClusterLeader("srv_a"),
    /Could not download the cluster release/,
  );
  assert.deepEqual(host.opened, []);
});

test("a leader newer than the pin is left alone", async () => {
  const host = fleet.host("srv_a", { status: leaderAt("0.3.0") });
  await assert.rejects(installClusterLeader("srv_a"), /newer than the v0.2.0/);
  assert.deepEqual(host.installs, []);
});

test("an agent without cluster.host is named, for every operation", async () => {
  const host = fleet.host("srv_old", { capabilities: [] });
  for (const run of [
    () => installClusterLeader("srv_old"),
    () => removeClusterLeader("srv_old"),
    () => clusterLeaderStatus("srv_old"),
    () => callClusterLeader("srv_old", "placement.place"),
  ]) {
    await assert.rejects(run, (e: Error) => {
      assert.ok(e instanceof AgentClusterUnsupportedError);
      assert.equal(e.message, CLUSTER_HOST_UNSUPPORTED_MESSAGE);
      return true;
    });
  }
  assert.deepEqual([host.installs, host.calls, host.removes], [[], [], 0]);
  assert.equal(host.closed, 4);
});

test("an agent that advertises it but answers UNIMPLEMENTED is named too", async () => {
  fleet.host("srv_a", { unimplemented: true });
  await assert.rejects(
    clusterLeaderStatus("srv_a"),
    AgentClusterUnsupportedError,
  );
});

test("a forwarded call reaches the leader and its answer comes back untouched", async () => {
  const host = fleet.host("srv_a", {
    status: leaderAt("0.2.0"),
    leader: (_m, p) => new Uint8Array([...p, 9]),
  });
  const out = await callClusterLeader(
    "srv_a",
    "placement.place",
    new Uint8Array([1, 2]),
  );
  assert.deepEqual([...out], [1, 2, 9]);
  assert.deepEqual(host.calls, [
    { method: "placement.place", payload: new Uint8Array([1, 2]) },
  ]);
});

test("a leader below clusterMin is refused in plain words and never called", async () => {
  const host = fleet.host("srv_a", { status: leaderAt("0.1.9") });
  await assert.rejects(
    callClusterLeader("srv_a", "placement.place"),
    (e: Error) => {
      assert.ok(e instanceof ClusterLeaderTooOldError);
      assert.match(
        e.message,
        /v0\.1\.9, older than the v0\.2\.0 this Deplo needs/,
      );
      assert.match(e.message, /Deplo's own server leads/);
      return true;
    },
  );
  assert.deepEqual(host.calls, []);
});

test("a canary of the floor's own release is below it, the release itself is not", async () => {
  fleet.host("srv_a", { status: leaderAt("0.2.0-canary.3") });
  await assert.rejects(
    callClusterLeader("srv_a", "leader.key"),
    ClusterLeaderTooOldError,
  );
  fleet.host("srv_b", { status: leaderAt("0.2.0") });
  await callClusterLeader("srv_b", "leader.key");
});

test("an unset floor refuses no leader", async () => {
  __setClusterPinForTest({ version: "", min: "" });
  fleet.host("srv_a", { status: leaderAt("0.0.1") });
  await callClusterLeader("srv_a", "leader.key");
});

test("no leader, or one that is down, is said so", async () => {
  fleet.host("srv_none");
  fleet.host("srv_down", { status: leaderAt("0.2.0", false) });
  await assert.rejects(
    callClusterLeader("srv_none", "leader.key"),
    /No cluster leader is installed/,
  );
  await assert.rejects(
    callClusterLeader("srv_down", "leader.key"),
    /not running/,
  );
});

test("the only way to a leader is connectAgent: no pin-free door, no dial of its own", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("./cluster-host.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /connectAgent\(serverId\)/);
  assert.doesNotMatch(src, /openAgent|serverChannel|new Client/);
});

test("a relay call goes to the relay through the server's agent, and only to a running relay", async () => {
  const host = fleet.host("srv_a", {
    status: { ...leaderAt("0.2.0"), relay: true },
    leader: () => new TextEncoder().encode("ok"),
  });
  const out = await callClusterRelay(
    "srv_a",
    "relay.roster",
    new TextEncoder().encode("{}"),
  );
  assert.equal(new TextDecoder().decode(out), "ok");
  assert.equal(host.calls[0].method, "relay.roster");

  fleet.host("srv_norelay", { status: leaderAt("0.2.0") });
  await assert.rejects(
    callClusterRelay("srv_norelay", "relay.roster"),
    /No cluster relay is running/,
  );
  fleet.host("srv_old_relay", {
    status: { ...leaderAt("0.1.0"), relay: true },
  });
  await assert.rejects(
    callClusterRelay("srv_old_relay", "relay.roster"),
    ClusterLeaderTooOldError,
  );
  fleet.host("srv_oldagent", { capabilities: [] });
  await assert.rejects(
    callClusterRelay("srv_oldagent", "relay.roster"),
    AgentClusterUnsupportedError,
  );
});

test("joining the relays needs the cluster capability, and an agent without it is named", async () => {
  const host = fleet.host("srv_a");
  const r = await setClusterMember("srv_a", true, ["https://r.example.com"]);
  assert.deepEqual(r, { member: true, relayLinks: 0 });
  assert.deepEqual(host.memberCalls, [
    { member: true, relays: ["https://r.example.com"] },
  ]);
  assert.equal(host.closed, 1);

  // cluster.host alone (an agent from before membership) does not carry it.
  const old = fleet.host("srv_old", { capabilities: ["cluster.host"] });
  await assert.rejects(setClusterMember("srv_old", true), (e: Error) => {
    assert.ok(e instanceof AgentClusterMemberUnsupportedError);
    assert.equal(e.message, CLUSTER_MEMBER_UNSUPPORTED_MESSAGE);
    return true;
  });
  assert.deepEqual(old.memberCalls, []);

  fleet.host("srv_unimpl", { unimplemented: true });
  await assert.rejects(
    setClusterMember("srv_unimpl", false),
    AgentClusterMemberUnsupportedError,
  );
});

test("remove goes through the agent, and removing nothing is fine", async () => {
  const host = fleet.host("srv_a");
  assert.deepEqual(await removeClusterLeader("srv_a"), { removed: false });
  await installClusterLeader("srv_a");
  assert.deepEqual(await removeClusterLeader("srv_a"), { removed: true });
  assert.equal(host.removes, 2);
});
