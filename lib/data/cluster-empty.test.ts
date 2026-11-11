import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { clusterMembers } from "../db/schema/control-plane/clusters";
import {
  emptyClusterMember,
  stopEmptyingClusterMember,
} from "./clusters/empty";
import { addClusterMember } from "./clusters/members";
import { PlacementRefusedError } from "./clusters/placement";
import {
  activity,
  appRow,
  asAdmin,
  asMember,
  asTeamB,
  asked,
  card,
  db,
  emptyLab,
  eu,
  member,
  rosters,
  runningApp,
} from "./cluster-empty-test-helpers";

emptyLab();

test("only an instance admin can empty a server or stop it, in the cluster's own team or another", async () => {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  for (const as of [asMember, asTeamB]) {
    await assert.rejects(
      as(() => emptyClusterMember(cluster.id, "srv_2")),
      /Only an instance admin can do that/,
    );
    await assert.rejects(
      as(() => stopEmptyingClusterMember(cluster.id, "srv_2")),
      /Only an instance admin can do that/,
    );
  }
  assert.equal((await member("srv_2")).emptyingSince, null);
  assert.equal((await appRow("web")).serverId, "srv_2");
  assert.deepEqual(asked, [], "the leader was never asked");
});

test("emptying sets emptying since, records who started it and tells the leader at once", async () => {
  await runningApp("web", "srv_2");
  await runningApp("api", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  const m = await member("srv_2");
  assert.ok(m.emptyingSince, "emptying since is set");
  assert.equal(m.emptyingTotal, 2);
  assert.equal(
    (await activity()).at(-1),
    "user_1: Started emptying server srv_2 of cluster eu: 2 to move",
  );
  assert.equal(rosters.length, 1, "the leader got a roster right away");
  assert.deepEqual(await card(cluster.id, "srv_2").then((c) => c.emptying), {
    since: m.emptyingSince,
    total: 2,
    left: 2,
    moving: "",
    error: "",
  });
  assert.equal((await card(cluster.id, "srv_3")).emptying, null);
});

test("the roster the leader gets marks the member as emptying", async () => {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  const sent = rosters.at(-1)!.members;
  assert.equal(sent.find((m) => m.id === "srv_2")?.emptying, true);
  assert.equal(sent.find((m) => m.id === "srv_3")?.emptying, false);
});

test("a server that is not in the cluster cannot be emptied", async () => {
  const cluster = await eu();
  await assert.rejects(
    asAdmin(() => emptyClusterMember(cluster.id, "srv_4")),
    /srv_4 is not in cluster eu/,
  );
  await assert.rejects(
    asAdmin(() => emptyClusterMember("clu_missing", "srv_2")),
    /Cluster not found/,
  );
});

test("emptying is refused before anything moves when the other servers lack the room, with the room sentence", async () => {
  await runningApp("web", "srv_2", { memoryMb: 4096 });
  await runningApp("big", "srv_3", { memoryMb: 6000 });
  const cluster = await eu();
  await assert.rejects(
    asAdmin(() => emptyClusterMember(cluster.id, "srv_2")),
    (e: unknown) =>
      e instanceof PlacementRefusedError &&
      e.message ===
        "No server in cluster eu has 4096 MB free. Add a server to it or lower web's memory.",
  );
  assert.equal((await member("srv_2")).emptyingSince, null);
  assert.equal((await appRow("web")).serverId, "srv_2");
  assert.deepEqual(asked, []);
  assert.deepEqual(rosters, []);
  assert.ok(!(await activity()).some((a) => a.includes("emptying")));
});

test("the room is counted for everything together, not one App at a time", async () => {
  await runningApp("api", "srv_2", { memoryMb: 5000 });
  await runningApp("web", "srv_2", { memoryMb: 5000 });
  const cluster = await eu();
  await assert.rejects(
    asAdmin(() => emptyClusterMember(cluster.id, "srv_2")),
    {
      message:
        "No server in cluster eu has 5000 MB free. Add a server to it or lower web's memory.",
    },
  );
  assert.equal((await member("srv_2")).emptyingSince, null);
});

test("with no other server ready to take the work, emptying is refused in those words", async () => {
  await runningApp("web", "srv_2");
  const alone = await eu(["srv_2"]);
  const nowhere = {
    message:
      "No server in cluster eu is online and ready right now, so web has nowhere to run. Bring a server back or add one.",
  };
  await assert.rejects(
    asAdmin(() => emptyClusterMember(alone.id, "srv_2")),
    nowhere,
  );
  await asAdmin(() => addClusterMember(alone.id, "srv_3"));
  for (const set of [
    { leaseState: "not_responding" },
    { emptyingSince: "2026-01-01T00:00:00.000Z" },
  ]) {
    await db
      .update(clusterMembers)
      .set({ leaseState: "ok", emptyingSince: null, ...set })
      .where(eq(clusterMembers.serverId, "srv_3"));
    await assert.rejects(
      asAdmin(() => emptyClusterMember(alone.id, "srv_2")),
      nowhere,
    );
  }
  assert.equal((await member("srv_2")).emptyingSince, null);
});

test("a server that runs nothing is emptied at once, even alone", async () => {
  const cluster = await eu(["srv_2"]);
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  assert.ok((await member("srv_2")).emptyingSince);
  assert.equal(
    (await activity()).at(-1),
    "user_1: Emptied server srv_2 of cluster eu: it ran nothing",
  );
  assert.equal((await card(cluster.id, "srv_2")).emptying?.left, 0);
});
