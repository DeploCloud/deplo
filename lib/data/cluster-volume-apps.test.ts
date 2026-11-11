import { test } from "node:test";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";

import { runWithIdentity } from "../auth/request-context";
import { RestoreRequest } from "../agent/gen/agent";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { appVolumes, apps as appsTable } from "../db/schema/control-plane/apps";
import { backups as backupsTable } from "../db/schema/control-plane/backups";
import {
  clusterMembers,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { membershipCapabilities } from "../db/schema/control-plane/access-control";
import { seedApp, seedDeployment } from "./app-graph-test-helpers";
import {
  bringAppBack,
  getAppFailover,
  setAppFailoverFromBackup,
} from "./apps/failover";
import { seedDestination, seedRun } from "./backup-test-helpers";
import {
  pushAppBundle,
  scheduleAppBundleRefresh,
} from "./clusters/app-restore";
import {
  type FailoverStack,
  flushFailoverBundles,
  reconcileClusterBundles,
} from "./clusters/bundles";
import { placementEntries } from "./clusters/leader-sync";
import { addClusterMember } from "./clusters/members";
import {
  TODAY_1415,
  apply,
  asAdmin,
  cannot,
  databaseLab,
  db,
  deploSaid,
  eu,
  event,
  leader,
  open,
  web,
} from "./cluster-database-test-helpers";
import { TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";

databaseLab();

const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

const STACK: FailoverStack = {
  slug: "web",
  projectId: "prj_web",
  imageRef: "deplo/web:dpl_1",
  composeYaml:
    "services:\n  web:\n    image: deplo/web:dpl_1\n    volumes:\n      - uploads:/data\nvolumes:\n  uploads:\n    name: deplo-web-uploads\n",
  network: "deplo-team-team_a",
  env: { TOKEN: "s3cret" },
  registryAuth: [],
  composeUpArgs: [],
};

type Kind = "named" | "app" | "host" | null;

async function keeps(appId: string, type: Kind, name = "uploads") {
  await db.insert(appVolumes).values({
    appId,
    position: 0,
    volumeId: `vol_${appId}`,
    type,
    name,
    hostPath: type === "host" ? "/srv/media" : null,
    mountPath: "/data",
    readOnly: false,
  });
}

/** "web" on srv_2 of the cluster, keeping what `type` says, deployed once so its leader holds a bundle. */
async function deployed(clusterId: string, type: Kind | "nothing" = "named") {
  await web(clusterId, "srv_2");
  if (type !== "nothing") await keeps("prj_web", type);
  await seedDeployment(db, { id: "dpl_1", appId: "prj_web", status: "ready" });
  await pushAppBundle({
    appId: "prj_web",
    deploymentId: "dpl_1",
    stack: STACK,
  });
}

/** A finished backup of "web" in the team's bucket. */
async function backedUp(id = "brun_a1", startedAt = TODAY_1415) {
  await seedDestination(db, { id: "dst_s3", name: "bucket" }).catch(() => {});
  await seedRun(db, {
    id,
    targetKind: "app",
    appId: "prj_web",
    destinationId: "dst_s3",
    objectKey: `deplo/team/app/prj_web/${id}.tar.gz.age`,
    sha256: "abc123",
    startedAt,
    finishedAt: startedAt,
  });
}

const schedules = (appId = "prj_web") =>
  db.select().from(backupsTable).where(eq(backupsTable.appId, appId));

const said = async (who: string) =>
  (await db.select().from(activitiesTable))
    .filter((a) => a.actor === who && a.appId === "prj_web")
    .map((a) => a.message);

const fenced = (serverId = "srv_2") =>
  db
    .update(clusterMembers)
    .set({ leaseState: "fenced" })
    .where(eq(clusterMembers.serverId, serverId));

test("an App with a Volume that arrives with its server gets the 15-minute backup, by the rule a database's follows", async () => {
  const cluster = await eu();
  await seedApp(db, { id: "prj_web", slug: "web", serverId: "srv_4" });
  await keeps("prj_web", "named");
  await seedApp(db, { id: "prj_plain", slug: "plain", serverId: "srv_4" });
  await seedApp(db, { id: "prj_bind", slug: "bind", serverId: "srv_4" });
  await keeps("prj_bind", "host");

  await asAdmin(() => addClusterMember(cluster.id, "srv_4"));

  const [b] = await schedules();
  assert.equal(b.name, "Failover backup");
  assert.equal(b.targetKind, "app");
  assert.equal(b.schedule, "*/15 * * * *");
  assert.equal(b.enabled, true);
  // No bucket: another member's disk, never the one it runs on.
  const dests = (await import("../db/schema/control-plane/backups"))
    .backupDestination;
  const [dest] = await db
    .select()
    .from(dests)
    .where(eq(dests.id, b.destinationId));
  assert.equal(dest.kind, "server");
  assert.ok(["srv_2", "srv_3"].includes(dest.serverId ?? ""));
  assert.deepEqual(await schedules("prj_plain"), []);
  assert.deepEqual(await schedules("prj_bind"), []);
  assert.match(
    (await said("Deplo")).join("\n"),
    /^Backs up prj_web every 15 minutes to \S+\. prj_web pauses while each backup is taken, so its files are copied whole\.$/m,
  );
});

test("by default a Volume App's bundle names no backup, so its leader makes it wait; its first deploy gives it the backup", async () => {
  const cluster = await eu();
  await deployed(cluster.id);

  const b = await open("app/prj_web");
  assert.equal(b.restore, undefined);
  assert.equal(b.stack.slug, "web");
  assert.equal((await schedules()).length, 1);
  assert.deepEqual(await cannot(), []);
  // The leader stops it first when its server's lease runs out: never two writers.
  const [entry] = await placementEntries(cluster.id);
  assert.equal(entry.singleWriter, true);
  // What a server that comes back still holds of it goes to the same destination, as its Volumes.
  const [schedule] = await schedules();
  assert.equal(b.keep!.ref, schedule.destinationId);
  const req = b.keep!.request as Record<string, Record<string, unknown>>;
  assert.equal(req.kind, "BACKUP_KIND_PROJECT");
  assert.deepEqual(req.project.volumeNames, ["deplo-web-uploads"]);
  assert.equal(req.store.objectKey, `deplo/${TEAM_A}/app/prj_web/left`);
  assert.equal(req.project.composeYaml ?? "", "");
});

test("a Volume row with no type and a stack's own volume are single-writer too; a Bind alone is not", async () => {
  const cluster = await eu();
  await web(cluster.id, "srv_2");
  await keeps("prj_web", null);
  for (const [id, compose] of [
    [
      "prj_stack",
      "services:\n  db:\n    image: x\n    volumes: [data:/d]\nvolumes:\n  data:\n",
    ],
    ["prj_bind", null],
    ["prj_plain", null],
  ] as const) {
    await seedApp(db, { id, slug: id, serverId: "srv_2", compose });
    await db
      .update(appsTable)
      .set({ clusterId: cluster.id })
      .where(eq(appsTable.id, id));
    await db.insert(workloadPlacements).values({
      kind: "app",
      workloadId: id,
      replica: 0,
      memberServerId: "srv_2",
      epoch: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  await keeps("prj_bind", "host");

  const single = Object.fromEntries(
    (await placementEntries(cluster.id)).map((e) => [e.id, e.singleWriter]),
  );
  assert.deepEqual(single, {
    prj_web: true,
    prj_stack: true,
    prj_bind: false,
    prj_plain: false,
  });
});

test("with the opt-in on, the bundle carries the latest backup another server can read, and each new backup reaches the leader", async () => {
  const cluster = await eu();
  await deployed(cluster.id);
  await backedUp();

  await asAdmin(() => setAppFailoverFromBackup("prj_web", true));

  let b = await open("app/prj_web");
  assert.equal(b.restore?.backupId, "brun_a1");
  assert.equal(b.restore?.takenAt, TODAY_1415);
  assert.equal(b.restore?.storeMember, undefined, "a bucket");
  const req = RestoreRequest.fromJSON(b.restore?.request);
  assert.equal(
    (b.restore?.request as { kind?: string }).kind,
    "BACKUP_KIND_PROJECT",
  );
  assert.equal(req.project?.slug, "web");
  assert.deepEqual(req.project?.volumeNames, ["deplo-web-uploads"]);
  assert.equal(req.s3?.objectKey, "deplo/team/app/prj_web/brun_a1.tar.gz.age");
  assert.equal(req.expectedSha256, "abc123");
  // The stack comes from the bundle, never from the backup.
  assert.equal(req.project?.composeYaml, "");
  assert.equal(b.stack.env.TOKEN, "s3cret");
  assert.deepEqual(await said(USER_1), [
    "Turned on failing web over automatically from its latest backup",
  ]);

  await backedUp("brun_a2", "2026-03-01T14:30:00.000Z");
  scheduleAppBundleRefresh("prj_web");
  await flushFailoverBundles();
  b = await open("app/prj_web");
  assert.equal(b.restore?.backupId, "brun_a2");

  await asAdmin(() => setAppFailoverFromBackup("prj_web", false));
  assert.equal((await open("app/prj_web")).restore, undefined);
});

test("the opt-in is refused for another team's App, for a Bind and for an App that keeps nothing", async () => {
  const cluster = await eu();
  await deployed(cluster.id);

  await assert.rejects(
    asTeamB(() => setAppFailoverFromBackup("prj_web", true)),
    /App not found/,
  );
  const [row] = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "prj_web"));
  assert.equal(row.failoverFromBackup, false);

  await db.update(appVolumes).set({ type: "host", hostPath: "/srv/media" });
  await assert.rejects(
    asAdmin(() => setAppFailoverFromBackup("prj_web", true)),
    /never fails over: it uses a folder that lives on server-2, and only on that machine\./,
  );
  await db.delete(appVolumes);
  await assert.rejects(
    asAdmin(() => setAppFailoverFromBackup("prj_web", true)),
    /keeps no Volume/,
  );
});

test("one click hands the leader the App's bundle sealed with the named backup, and Activity names it", async () => {
  const cluster = await eu();
  await deployed(cluster.id);
  await backedUp();
  await fenced();

  await asAdmin(() => bringAppBack("prj_web"));

  assert.equal(leader.moves.length, 1);
  assert.equal(`${leader.moves[0].kind}/${leader.moves[0].id}`, "app/prj_web");
  const sent = await open(leader.moves[0].sealed);
  assert.equal(sent.restore?.backupId, "brun_a1");
  assert.equal(sent.workload, "prj_web");
  assert.equal(sent.deploymentId, "dpl_1");
  assert.equal(sent.stack.composeYaml, STACK.composeYaml);
  assert.deepEqual(await said(USER_1), [
    "Asked cluster eu to bring web back on another server from the backup of 14:15",
  ]);
  // The bundle the leader keeps still names no backup: next time it waits again.
  assert.equal((await open("app/prj_web")).restore, undefined);
});

test("the leader refusing because its server may still run it reaches the person, and nothing is recorded", async () => {
  const cluster = await eu();
  await deployed(cluster.id);
  await backedUp();
  leader.moveAnswer = { ok: false, reason: "still_answering" };

  await assert.rejects(
    asAdmin(() => bringAppBack("prj_web")),
    /server may still be running it\. Deplo never starts a second copy next to one that could be writing: try again in a minute\./,
  );
  assert.deepEqual(await said(USER_1), []);
});

test("bringing an App back is refused across teams, without restore_backups and with no backup to read", async () => {
  const cluster = await eu();
  await deployed(cluster.id);

  await assert.rejects(
    asAdmin(() => bringAppBack("prj_web")),
    /web cannot be brought back: it has no finished backup yet\./,
  );
  await backedUp();
  await assert.rejects(
    asTeamB(() => bringAppBack("prj_web")),
    /App not found/,
  );
  await db
    .delete(membershipCapabilities)
    .where(
      and(
        eq(membershipCapabilities.membershipId, `mem_${USER_1}`),
        eq(membershipCapabilities.capability, "restore_backups"),
      ),
    );
  await assert.rejects(
    asAdmin(() => bringAppBack("prj_web")),
    /You don't have permission to/,
  );
  assert.equal(leader.moves.length, 0, "nothing reached the leader");
});

test("a failover that restored a Volume App says which backup, and a move that failed says why", async () => {
  const cluster = await eu();
  await deployed(cluster.id);
  await backedUp();

  await apply(
    cluster.id,
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: "prj_web",
      members: ["srv_3"],
      epoch: 1,
    }),
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: "prj_web",
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
      backupId: "brun_a1",
      backupAt: TODAY_1415,
    }),
    event(cluster.id, "move_failed", {
      kind: "app",
      workloadId: "prj_web",
      reason: "no_room",
    }),
  );

  const lines = (await deploSaid(TEAM_A)).filter((m) =>
    /Restored|Moved|Could not/.test(m),
  );
  assert.deepEqual(lines, [
    "Restored web on server-3 from the backup of 14:15",
    "Could not bring web back on another server. No other server of the cluster has room for web.",
  ]);
});

test("an App with a Bind holds no bundle, gets no backup, and its page says why it never fails over", async () => {
  const cluster = await eu();
  await deployed(cluster.id, "nothing");
  assert.ok(leader.held.has("app/prj_web"), "stateless: it fails over");

  await keeps("prj_web", "host");
  await pushAppBundle({
    appId: "prj_web",
    deploymentId: "dpl_1",
    stack: STACK,
  });
  assert.equal(leader.held.has("app/prj_web"), false);
  await reconcileClusterBundles(cluster.id);
  assert.equal(leader.held.has("app/prj_web"), false, "the sweep sends none");
  assert.deepEqual(await schedules(), []);
  assert.deepEqual(await cannot(), []);

  const page = await asAdmin(() => getAppFailover("prj_web"));
  assert.equal(page?.disk, "bind");
  assert.equal(
    page?.sentence,
    "web never fails over: it uses a folder that lives on server-2, and only on that machine.",
  );
  assert.equal(page?.bringBack, null);
});

test("the page of a Volume App says it waits, and offers the click naming the backup once its server has stopped", async () => {
  const cluster = await eu();
  await deployed(cluster.id);

  let page = await asAdmin(() => getAppFailover("prj_web"));
  assert.equal(page?.disk, "volume");
  assert.equal(page?.waiting, false);
  assert.equal(page?.bringBack, null);
  assert.equal(
    page?.sentence,
    "web waits for server-2 if it stops, so it never starts on old files. You can bring it back on another server from its latest backup.",
  );

  await fenced();
  page = await asAdmin(() => getAppFailover("prj_web"));
  assert.equal(page?.waiting, true);
  assert.equal(page?.bringBack, null);
  assert.equal(
    page?.why,
    "web cannot be brought back: it has no finished backup yet.",
  );

  await backedUp();
  page = await asAdmin(() => getAppFailover("prj_web"));
  assert.equal(
    page?.bringBack,
    "Bring web back on another server from the backup of 14:15",
  );
  assert.equal(page?.why, null);

  assert.equal(await asTeamB(() => getAppFailover("prj_web")), null);
});
