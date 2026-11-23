import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { __setRunnerForTest } from "../deploy/deploy-queue";
import { NEWEST_WINS_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { moveClusterDataBeforeStart } from "./app-migration";
import { moveAppToCluster } from "./apps/source";
import { removeClusterMember } from "./clusters/dissolve";
import { runEmptyingPass } from "./clusters/empty";
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
