import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { __setRunnerForTest } from "../deploy/deploy-queue";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { pendingTeardowns } from "../db/schema/control-plane/deployments";
import type { AgentConnection } from "../infra/agent-client/connection";
import {
  NEWEST_WINS_CAPABILITY,
  SET_ASIDE_FILES_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import {
  __forgetMoveTries,
  moveClusterDataBeforeStart,
  moveRetry,
} from "./app-migration";
import { __setDeployAnywayForTest, acceptDataCopyLoss } from "./data-copy";
import { drainTeardowns } from "./teardown-queue";
import {
  AgentOfflineError,
  AgentUnreachableError,
} from "../infra/agent-client/errors";
import { moveAppToCluster } from "./apps/source";
import { removeClusterMember } from "./clusters/dissolve";
import { VOLUME_COPY_MEMBER_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { runEmptyingPass } from "./clusters/empty";
import {
  __forgetTurns,
  setReplicaTurns,
  turnWait,
} from "./clusters/copy-turns";
import {
  activity,
  appRow,
  asAdmin,
  card,
  db,
  deployLands,
  disks,
  emptyLab,
  eu,
  hosts,
  pg,
  runningApp,
  tarWith,
} from "./cluster-empty-test-helpers";

// A moved App's copy that ran last wins, and the other is set aside, never written over (fise, 23 Nov 2026).

emptyLab();

const VOL = "deplo-fise-data";
const YAML = `services:\n  app:\n    image: nginx:1\n    volumes:\n      - ${VOL}:/data\nvolumes:\n  ${VOL}:\n    name: ${VOL}\n`;
const OLD = tarWith("data/rows", "rows 1-100, as eu-4 stopped at 07:42:33");
const NEW = tarWith("data/rows", "rows 1-142, written on eu-1 for 7 minutes");

async function fise(on: string) {
  await runningApp("fise", on);
  await pg.exec(
    `insert into app_volumes (volume_id, app_id, position, type, name, mount_path, read_only)
       values ('vol_1', 'fise', 0, 'named', 'data', '/data', false)`,
  );
  for (const id of ["srv_2", "srv_3"])
    hosts.get(id)!.capabilities.push(NEWEST_WINS_CAPABILITY);
  disks.get(on)!.stacks.set("fise", YAML);
}

test("removing a member that holds an older copy keeps the copy that ran since, and sets the older one aside", async () => {
  // srv_2 is eu-4: fise ran there until it was moved off it.
  await fise("srv_2");
  disks.get("srv_2")!.volumes.set(VOL, OLD);
  const cluster = await eu();
  await asAdmin(() => removeClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  assert.equal((await appRow("fise")).serverId, "srv_3");

  // Its first deploy on srv_3 (eu-1) started it and reported a failure: it then served there for seven minutes.
  const eu1 = disks.get("srv_3")!;
  eu1.stacks.set("fise", YAML);
  eu1.volumes.set(VOL, NEW);
  eu1.ran.set("fise", { lastRanMs: Date.now(), running: true });
  disks.get("srv_2")!.ran.set("fise", {
    lastRanMs: Date.now() - 7 * 60_000,
    running: false,
  });
  await db
    .update(deploymentsTable)
    .set({ status: "error" })
    .where(eq(deploymentsTable.appId, "fise"));
  await runEmptyingPass();
  assert.match(
    (await card(cluster.id, "srv_2")).emptying?.error ?? "",
    /did not finish moving/,
  );

  // "Continue removing" deploys it again, with the move still marked from srv_2.
  await asAdmin(() => removeClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  assert.equal(await deployLands("fise"), "kept");

  assert.deepEqual(eu1.volumes.get(VOL), NEW, "the newest rows win");
  assert.deepEqual(
    eu1.volumes.get(`${VOL}-aside-${aside(eu1)}`),
    OLD,
    "the older copy is set aside where fise runs",
  );
  assert.ok(!eu1.calls.includes(`import:${VOL}`), "nothing was copied over it");
  assert.ok(!disks.get("srv_2")!.volumes.has(VOL), "the old one went after");
  assert.equal((await appRow("fise")).migrateFromServerId, null);
  assert.ok(
    (await activity()).some((l) =>
      /Kept fise's data on .*, which ran it after .* did\. .*older copy was set aside/.test(
        l,
      ),
    ),
  );
  await runEmptyingPass();
  assert.equal(await card(cluster.id, "srv_2"), undefined, "it left");
});

// The stamp of the one copy srv_3 holds of another server's volume.
function aside(d: typeof disks extends Map<string, infer D> ? D : never) {
  const call = d.calls.find((c) => c.startsWith(`import-aside:${VOL}-aside-`));
  assert.ok(call, `no copy was set aside: ${d.calls.join(" ")}`);
  return call.slice(`import-aside:${VOL}-aside-`.length);
}

test("a move copies the data before the new member starts it, and sets aside what that member held", async () => {
  await fise("srv_2");
  disks.get("srv_2")!.volumes.set(VOL, OLD);
  // The lease stopped it on srv_2 a moment ago; srv_3 holds a leftover of an earlier stay and no stack.
  disks.get("srv_2")!.ran.set("fise", {
    lastRanMs: Date.now() - 2_000,
    running: false,
  });
  const stale = tarWith("data/rows", "rows 1-40, from a stay long ago");
  const eu1 = disks.get("srv_3")!;
  eu1.volumes.set(VOL, stale);
  eu1.ran.set("fise", { lastRanMs: Date.now() - 86_400_000, running: false });
  const cluster = await eu();
  // The deploy the move queues is this test's to run: a stand-in that settles its row.
  __setRunnerForTest(async (depId) => {
    await db
      .update(deploymentsTable)
      .set({ status: "canceled" })
      .where(eq(deploymentsTable.id, depId));
  });
  await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));

  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", () => {}),
    "done",
  );
  assert.deepEqual(eu1.volumes.get(VOL), OLD, "srv_2 ran it last");
  assert.deepEqual(
    eu1.volumes.get(`${VOL}-aside-20261123T074913Z`),
    stale,
    "what srv_3 held is set aside first",
  );
  assert.ok(
    eu1.calls.indexOf(`aside:${VOL}`) < eu1.calls.indexOf(`import:${VOL}`),
  );
  assert.ok(
    !eu1.calls.includes("start:fise") && !eu1.calls.includes("stop:fise"),
    "the deploy starts it, once its data is there",
  );
  assert.equal((await appRow("fise")).migrateFromServerId, null);
  // The deploy that follows finds nothing left to copy.
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", () => {}),
    "nothing",
  );
  __setRunnerForTest(async () => {});
});

const FILES = tarWith("files/upload.png", "an upload only srv_2 holds");
const FILES_ASIDE = "deplo-fise.files-aside-20261123T080000Z";

/** fise moved to srv_3 while srv_2, which holds its data and Files, did not answer: the move is held. */
async function heldMove() {
  await fise("srv_2");
  const old = disks.get("srv_2")!;
  old.volumes.set(VOL, OLD);
  const host = hosts.get("srv_2")!;
  host.capabilities.push(SET_ASIDE_FILES_CAPABILITY);
  const ops = host.extra as Partial<AgentConnection>;
  const plain = ops.setAside!;
  // Its agent sets the Files folder aside with whatever volumes it is asked for.
  ops.setAside = async (slug, names) => {
    const out = await plain(slug, names);
    old.calls.push(`aside-files:${slug}`);
    old.volumes.set(FILES_ASIDE, FILES);
    return [
      ...out,
      { volumeName: FILES_ASIDE, of: "deplo-fise.files", atMs: 1, bytes: 9 },
    ];
  };
  ops.removeSetAside = async (name) => {
    old.calls.push(`remove-aside:${name}`);
    old.volumes.delete(name);
    return { ok: true, error: "" };
  };
  const cluster = await eu();
  await db
    .update(appsTable)
    .set({
      clusterId: cluster.id,
      serverId: "srv_3",
      migrateFromServerId: "srv_2",
      dataCopyError: "srv_2 could not be reached to copy it",
    })
    .where(eq(appsTable.id, "fise"));
  return old;
}

async function said(re: RegExp): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const line = (await activity()).find((l) => re.test(l));
    if (line) return line;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`never said ${re}: ${(await activity()).join("\n")}`);
}

test('"Deploy anyway" on a held move sets the old copy and its Files aside where the App runs, never deletes them', async (t) => {
  t.after(() => __setDeployAnywayForTest());
  const old = await heldMove();
  let deployedAfter = "";
  __setDeployAnywayForTest(async () => {
    deployedAfter = old.calls.join(" ");
    return "dep_none";
  });
  // On disk a copy takes more than the compressed stream that brought it.
  const ops = hosts.get("srv_3")!.extra as Partial<AgentConnection>;
  ops.volumeUsage = async (names: string[]) =>
    new Map(names.map((n) => [n, 41_041_920] as const));
  await asAdmin(() => acceptDataCopyLoss({ kind: "app", id: "fise" }));
  await said(/What srv_2 held of fise was set aside on srv_3 \(78\.3 MiB\)/);

  const eu1 = disks.get("srv_3")!;
  assert.deepEqual(eu1.volumes.get(`${VOL}-aside-${aside(eu1)}`), OLD);
  assert.deepEqual(eu1.volumes.get(FILES_ASIDE), FILES, "its Files too");
  assert.ok(eu1.calls.includes(`import-aside:${FILES_ASIDE}`));
  assert.ok(
    old.calls.indexOf(`export:${VOL}`) < old.calls.indexOf("destroy:fise") &&
      old.calls.indexOf(`remove-aside:${FILES_ASIDE}`) <
        old.calls.indexOf("destroy:fise"),
    `srv_2's copy went only once it was set aside: ${old.calls.join(" ")}`,
  );
  const row = await appRow("fise");
  assert.equal(row.migrateFromServerId, null);
  assert.equal(row.dataCopyError, "");
  assert.match(
    deployedAfter,
    /stop:fise/,
    "the same click deploys, once the old copy is stopped",
  );
});

test('"Deploy anyway" deploys the App, and Activity says "Deployed" only once that deploy is ready', async (t) => {
  t.after(() => __setRunnerForTest(async () => {}));
  await heldMove();
  const ops = hosts.get("srv_2")!.extra as Partial<AgentConnection>;
  ops.readStack = async () => {
    throw new AgentOfflineError("srv_2");
  };
  let release = () => {};
  const ready = new Promise<void>((r) => (release = r));
  __setRunnerForTest(async (depId) => {
    await ready;
    await db
      .update(deploymentsTable)
      .set({ status: "ready" })
      .where(eq(deploymentsTable.id, depId));
  });
  await asAdmin(() => acceptDataCopyLoss({ kind: "app", id: "fise" }));
  await said(/: Deploying fise$/);
  assert.ok(
    !(await activity()).some((l) => /: Deployed fise/.test(l)),
    "nothing says Deployed before the deploy is done",
  );
  release();
  for (let i = 0; i < 60; i++) {
    if (
      (await activity()).some((l) =>
        /: Deployed fise without the data its previous server still holds$/.test(
          l,
        ),
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`never said Deployed: ${(await activity()).join("\n")}`);
});

test('"Deploy anyway" while the old member is silent deletes nothing there, and sets its copy aside once it answers', async (t) => {
  t.after(() => __setDeployAnywayForTest());
  __setDeployAnywayForTest(async () => "dep_none");
  const old = await heldMove();
  const ops = hosts.get("srv_2")!.extra as Partial<AgentConnection>;
  const readStack = ops.readStack!;
  ops.readStack = async () => {
    throw new AgentOfflineError("srv_2");
  };
  await asAdmin(() => acceptDataCopyLoss({ kind: "app", id: "fise" }));
  await said(
    /srv_2 does not answer, so what it holds of fise stays on it for now: Activity says where it is kept once srv_2 answers again/,
  );
  assert.ok(!old.calls.includes("destroy:fise"));
  assert.deepEqual(old.volumes.get(VOL), OLD);
  assert.equal((await db.select().from(pendingTeardowns)).length, 1);
  assert.ok(
    (await activity()).some((l) =>
      /Accepted that fise starts without the data its previous server still holds: Deplo sets that copy aside, never deletes it/.test(
        l,
      ),
    ),
  );

  // Back, the queue sets the copy aside where fise runs before it removes it there.
  ops.readStack = readStack;
  ops.listInstances = (async () =>
    old.stacks.has("fise") ? [{ name: "deplo-fise" }] : []) as never;
  await drainTeardowns(new Date(Date.now() + 10 * 60_000));
  const eu1 = disks.get("srv_3")!;
  assert.deepEqual(eu1.volumes.get(`${VOL}-aside-${aside(eu1)}`), OLD);
  assert.deepEqual(eu1.volumes.get(FILES_ASIDE), FILES);
  assert.ok(old.calls.includes("destroy:fise"));
  assert.deepEqual(await db.select().from(pendingTeardowns), []);
  await said(
    /What srv_2 held of fise was set aside on srv_3 .* Finished the teardown of fise on srv_2/,
  );
});

// eu, 24 Nov 2026: a move's 600 MB went from eu-4 to eu-3 through Deplo, across the lab's internet line twice.
async function moveBetweenMembers(noPath: boolean) {
  await fise("srv_2");
  for (const id of ["srv_2", "srv_3"])
    hosts.get(id)!.capabilities.push(VOLUME_COPY_MEMBER_CAPABILITY);
  const old = disks.get("srv_2")!;
  old.volumes.set(VOL, OLD);
  old.ran.set("fise", { lastRanMs: Date.now() - 2_000, running: false });
  if (noPath) old.fail.memberPath = "no path";
  const cluster = await eu();
  __setRunnerForTest(async (depId) => {
    await db
      .update(deploymentsTable)
      .set({ status: "canceled" })
      .where(eq(deploymentsTable.id, depId));
  });
  await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", () => {}),
    "done",
  );
  const to = disks.get("srv_3")!;
  assert.deepEqual(to.volumes.get(VOL), OLD);
  assert.ok(
    to.calls.includes(`expect:${VOL}:2`),
    "srv_3 was told to take it from srv_2",
  );
  return { old, to };
}

test("a move between two members copies the data between them, not through Deplo", async () => {
  const { old, to } = await moveBetweenMembers(false);
  assert.ok(to.calls.includes(`member-import:${VOL}`));
  assert.ok(!old.calls.includes(`export:${VOL}`), "Deplo carried nothing");
  await said(/Moved fise's data from srv_2 to srv_3, server to server/);
});

test("a move Deplo carries only when no path joins the two members, and Activity says so", async () => {
  const { to } = await moveBetweenMembers(true);
  assert.ok(to.calls.includes(`import:${VOL}`), "Deplo carried it");
  await said(/Moved fise's data from srv_2 to srv_3, through Deplo/);
});

// c37: eu-4's link closed mid-copy (21:30:44) and the move rolled back; a dropped link now never ends a move.
test("a move whose copy breaks when a link drops runs the App where it was, then goes again by itself", async () => {
  __forgetMoveTries();
  await fise("srv_2");
  for (const id of ["srv_2", "srv_3"])
    hosts.get(id)!.capabilities.push(VOLUME_COPY_MEMBER_CAPABILITY);
  const old = disks.get("srv_2")!;
  old.volumes.set(VOL, OLD);
  old.ran.set("fise", { lastRanMs: Date.now() - 2_000, running: true });
  const cluster = await eu();
  __setRunnerForTest(async (depId) => {
    await db
      .update(deploymentsTable)
      .set({ status: "canceled" })
      .where(eq(deploymentsTable.id, depId));
  });
  await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
  const ops = hosts.get("srv_2")!.extra as Partial<AgentConnection>;
  const send = ops.sendClusterVolume;
  ops.sendClusterVolume = async () => {
    throw new AgentUnreachableError(
      "14 UNAVAILABLE: connect ENOENT /tmp/deplo-link-x/15.sock",
    );
  };
  moveRetry.waitMs = 10;
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", () => {}),
    "rolled-back",
  );
  assert.equal((await appRow("fise")).serverId, "srv_2");
  assert.ok(old.calls.includes("start:fise"), "it runs where it was");
  await said(
    /Moving fise to srv_3 broke when a link dropped - it runs on srv_2 again, and the move goes again by itself/,
  );
  ops.sendClusterVolume = send;
  for (let i = 0; i < 300; i++) {
    if ((await appRow("fise")).serverId === "srv_3") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal((await appRow("fise")).migrateFromServerId, "srv_2");
  const lines: string[] = [];
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", (_l, t) =>
      lines.push(t),
    ),
    "done",
    lines.join("\n"),
  );
  assert.deepEqual(disks.get("srv_3")!.volumes.get(VOL), OLD);
  moveRetry.waitMs = 5_000;
  __setRunnerForTest(async () => {});
});

// c38: two moves waited in the queue while the lease had already stopped their Apps on the old server.
test("a move never waits its turn: its App is down until it runs, so it starts at once", async () => {
  setReplicaTurns(
    new Map([
      ["srv_2", "a copy of shop"],
      ["srv_3", "a copy of shop"],
    ]),
  );
  turnWait.pollMs = 60_000;
  try {
    const { to } = await moveBetweenMembers(false);
    assert.ok(to.calls.includes(`member-import:${VOL}`));
  } finally {
    turnWait.pollMs = 5_000;
    __forgetTurns();
  }
});

// c38: eu-3's own link was cut mid-move, so it could not be told to start lab-pc again, and the move gave up.
test("a move whose old server dropped its link starts the App there once it answers, then goes again", async () => {
  __forgetMoveTries();
  await fise("srv_2");
  for (const id of ["srv_2", "srv_3"])
    hosts.get(id)!.capabilities.push(VOLUME_COPY_MEMBER_CAPABILITY);
  const old = disks.get("srv_2")!;
  old.volumes.set(VOL, OLD);
  old.ran.set("fise", { lastRanMs: Date.now() - 2_000, running: true });
  const cluster = await eu();
  __setRunnerForTest(async (depId) => {
    await db
      .update(deploymentsTable)
      .set({ status: "canceled" })
      .where(eq(deploymentsTable.id, depId));
  });
  await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
  const ops = hosts.get("srv_2")!.extra as Partial<AgentConnection>;
  const [send, start] = [ops.sendClusterVolume, ops.startStack];
  const link = (e: string) => () => {
    throw new AgentUnreachableError(e);
  };
  ops.sendClusterVolume = link("14 UNAVAILABLE: Connection dropped");
  ops.startStack = link("14 UNAVAILABLE: Connection dropped");
  moveRetry.waitMs = 10;
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", () => {}),
    "rolled-back",
  );
  await said(
    /Moving fise to srv_3 broke when a link dropped - it starts on srv_2 again once that server answers, and the move goes again by itself/,
  );
  [ops.sendClusterVolume, ops.startStack] = [send, start];
  for (let i = 0; i < 300; i++) {
    if ((await appRow("fise")).serverId === "srv_3") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(old.calls.includes("start:fise"), "it ran where it was first");
  assert.equal(
    await moveClusterDataBeforeStart("fise", "srv_3", "fise", () => {}),
    "done",
  );
  moveRetry.waitMs = 5_000;
  __setRunnerForTest(async () => {});
});

// c38: the copy landed on eu-1, but the next call went over the link the cut had closed (`Channel has been shut
// down`): each volume now goes on connections of its own.
test("a move's next volume goes on a fresh connection, never one a dropped link left behind", async () => {
  __forgetMoveTries();
  await fise("srv_2");
  const VOL2 = "deplo-fise-cache";
  await pg.exec(
    `insert into app_volumes (volume_id, app_id, position, type, name, mount_path, read_only)
       values ('vol_2', 'fise', 1, 'named', 'cache', '/cache', false)`,
  );
  const old = disks.get("srv_2")!;
  old.stacks.set(
    "fise",
    `services:\n  app:\n    image: nginx:1\n    volumes:\n      - ${VOL}:/data\n      - ${VOL2}:/cache\nvolumes:\n  ${VOL}:\n    name: ${VOL}\n  ${VOL2}:\n    name: ${VOL2}\n`,
  );
  old.volumes.set(VOL, OLD);
  old.volumes.set(VOL2, NEW);
  old.ran.set("fise", { lastRanMs: Date.now() - 2_000, running: false });
  for (const id of ["srv_2", "srv_3"])
    hosts.get(id)!.capabilities.push(VOLUME_COPY_MEMBER_CAPABILITY);
  const ops = hosts.get("srv_3")!.extra as Partial<AgentConnection>;
  const expect = ops.expectClusterVolume!;
  const used = new WeakSet<object>();
  ops.expectClusterVolume = async function (this: object, ...a) {
    if (used.has(this)) throw new Error("Channel has been shut down");
    used.add(this);
    return expect.apply(this, a);
  };
  const cluster = await eu();
  __setRunnerForTest(async (depId) => {
    await db
      .update(deploymentsTable)
      .set({ status: "canceled" })
      .where(eq(deploymentsTable.id, depId));
  });
  try {
    await asAdmin(() => moveAppToCluster("fise", cluster.id, "srv_3"));
    assert.equal(
      await moveClusterDataBeforeStart("fise", "srv_3", "fise", () => {}),
      "done",
    );
    assert.deepEqual(disks.get("srv_3")!.volumes.get(VOL2), NEW);
  } finally {
    ops.expectClusterVolume = expect;
    __setRunnerForTest(async () => {});
  }
});
