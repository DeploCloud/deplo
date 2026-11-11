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
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { clusterImageCopies } from "../db/schema/control-plane/clusters";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { nowIso } from "../ids";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import { createCluster } from "./clusters/manage";
import { rollbackKeepBySlug } from "./docker-cleanup/live-inventory";
import { addClusterMember } from "./clusters/members";
import { clearPlacement } from "./clusters/placement";
import {
  copyImageAfterDeploy,
  copyReleaseToMembers,
  isBuiltImage,
  listClusterImageProgress,
  membersHoldingImage,
  reconcileClusterImages,
} from "./clusters/images";
import { invalidateFrozen } from "./deplo-move/freeze";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let origFetch: typeof fetch;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const REL1 = "deplo/web:dpl_aaaaaaaa";
const REL2 = "deplo/web:dpl_bbbbbbbb";
const REL3 = "deplo/web:dpl_cccccccc";
const everyone = { allTeams: true, teamIds: [] as string[] };

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

const hostOf = (id: string): FakeClusterHost => hosts[id]!;
let hosts: Record<string, FakeClusterHost>;

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
  for (const [i, id] of ["srv_2", "srv_3", "srv_4"].entries()) {
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
  });
  for (const id of ["srv_2", "srv_3", "srv_4"]) hosts[id] = fleet.host(id);
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
  invalidateFrozen();
});

afterEach(async () => {
  fleet.restore();
  __setClusterPinForTest(null);
  __resetReleaseCacheForTests();
  globalThis.fetch = origFetch;
  await db.delete(deploMoves);
  invalidateFrozen();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

/** A cluster of three amd64 servers with an App running on the first. */
async function clusterWithApp(members = ["srv_2", "srv_3", "srv_4"]) {
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  for (const m of members) await asAdmin(() => addClusterMember(cluster.id, m));
  await seedApp(db, { id: "app_web", serverId: "srv_2" });
  await db
    .update(appsTable)
    .set({ clusterId: cluster.id })
    .where(eq(appsTable.id, "app_web"));
  return cluster;
}

const rows = async () =>
  (await db.select().from(clusterImageCopies)).sort(
    (a, b) =>
      a.imageRef.localeCompare(b.imageRef) ||
      a.serverId.localeCompare(b.serverId),
  );
const states = async (ref: string) =>
  Object.fromEntries(
    (await rows())
      .filter((r) => r.imageRef === ref)
      .map((r) => [r.serverId, r.state]),
  );

async function until(what: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a built image is copied from the server that ran it to every other member and each holding is recorded", async () => {
  await clusterWithApp();
  await copyReleaseToMembers("app_web", REL1, "srv_2");

  assert.deepEqual(
    hostOf("srv_2").imageCopies.map((c) => [c.targetFingerprint, c.keep]),
    [
      ["3".repeat(64), 2],
      ["4".repeat(64), 2],
    ],
  );
  assert.ok(hostOf("srv_2").imageCopies.every((c) => c.imageRef === REL1));
  assert.deepEqual(hostOf("srv_3").imageCopies, []);
  assert.deepEqual(await states(REL1), {
    srv_2: "held",
    srv_3: "held",
    srv_4: "held",
  });
  assert.deepEqual((await membersHoldingImage("app_web", REL1)).sort(), [
    "srv_2",
    "srv_3",
    "srv_4",
  ]);
});

test("the deploy's tail asks for the copies after a successful build, in the background", async () => {
  await clusterWithApp();
  await seedDeployment(db, {
    id: "dpl_1",
    appId: "app_web",
    serverId: "srv_2",
    imageRef: REL1,
  });
  copyImageAfterDeploy("dpl_1", "srv_2");
  await until("both copies", async () => (await rows()).length === 3);
  await until("the copies to land", async () =>
    (await rows()).every((r) => r.state === "held"),
  );
});

test("a pulled image needs no copy and an App outside a cluster none either", async () => {
  await clusterWithApp();
  await seedDeployment(db, {
    id: "dpl_p",
    appId: "app_web",
    serverId: "srv_2",
    imageRef: "nginx:1.27",
  });
  await seedApp(db, { id: "plain", serverId: "srv_2" });
  await seedDeployment(db, {
    id: "dpl_q",
    appId: "plain",
    serverId: "srv_2",
    imageRef: REL1,
  });
  copyImageAfterDeploy("dpl_p", "srv_2");
  copyImageAfterDeploy("dpl_q", "srv_2");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(hostOf("srv_2").imageCopies, []);
  assert.deepEqual(await rows(), []);
  assert.equal(isBuiltImage("nginx:1.27"), false);
  assert.equal(isBuiltImage(REL1), true);
});

test("only members of the image's architecture are asked, and a member of another is never a target", async () => {
  const cluster = await clusterWithApp();
  await db
    .update(serversTable)
    .set({ hostArch: "arm64" })
    .where(eq(serversTable.id, "srv_4"));
  await copyReleaseToMembers("app_web", REL1, "srv_2");

  assert.deepEqual(
    hostOf("srv_2").imageCopies.map((c) => c.targetFingerprint),
    ["3".repeat(64)],
  );
  assert.deepEqual(await states(REL1), { srv_2: "held", srv_3: "held" });
  assert.deepEqual(
    await asAdmin(() => listClusterImageProgress(cluster.id)),
    [],
  );
});

test("a member still copying is not a holder, and the card shows how far it is", async () => {
  const cluster = await clusterWithApp();
  hostOf("srv_2").imageCopy = (_ref, fp) => {
    if (fp === "3".repeat(64)) throw new Error("the relay dropped the stream");
    return { alreadyPresent: false, bytes: 5, pruned: [] };
  };
  await copyReleaseToMembers("app_web", REL1, "srv_2");

  assert.deepEqual(await states(REL1), {
    srv_2: "held",
    srv_3: "failed",
    srv_4: "held",
  });
  assert.deepEqual((await membersHoldingImage("app_web", REL1)).sort(), [
    "srv_2",
    "srv_4",
  ]);
  const failed = (await rows()).find((r) => r.serverId === "srv_3")!;
  assert.match(failed.error, /the relay dropped the stream/);
  assert.deepEqual(await asAdmin(() => listClusterImageProgress(cluster.id)), [
    { appId: "app_web", appName: "app_web", held: 2, total: 3 },
  ]);

  // The next sweep retries it, and the line clears once every member holds the image.
  hostOf("srv_2").imageCopy = () => ({
    alreadyPresent: false,
    bytes: 5,
    pruned: [],
  });
  hostOf("srv_2").imageCopies.length = 0;
  await reconcileClusterImages();
  assert.deepEqual(
    hostOf("srv_2").imageCopies.map((c) => c.targetFingerprint),
    ["3".repeat(64)],
  );
  assert.deepEqual(
    await asAdmin(() => listClusterImageProgress(cluster.id)),
    [],
  );
});

test("a release that finishes while the one before is still copying is copied too", async () => {
  await clusterWithApp();
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const quick = hostOf("srv_2").imageCopy;
  // The agent's answer is awaited, so the first copy can be held open.
  hostOf("srv_2").imageCopy = ((ref: string, fp: string, keep: number) =>
    ref === REL1
      ? gate.then(() => quick(ref, fp, keep))
      : quick(ref, fp, keep)) as typeof quick;
  const first = copyReleaseToMembers("app_web", REL1, "srv_2");
  await until(
    "the first copy to start",
    async () => hostOf("srv_2").imageCopies.length > 0,
  );
  const second = copyReleaseToMembers("app_web", REL2, "srv_2");
  release();
  await Promise.all([first, second]);

  assert.deepEqual(await states(REL2), {
    srv_2: "held",
    srv_3: "held",
    srv_4: "held",
  });
});

test("the image cleanup keeps the last two releases on every member that holds them, not only where the App runs", async () => {
  await clusterWithApp();
  await db
    .update(appsTable)
    .set({ rollbackKeep: 0 })
    .where(eq(appsTable.id, "app_web"));
  assert.deepEqual(await rollbackKeepBySlug("srv_3"), {});
  await copyReleaseToMembers("app_web", REL1, "srv_2");
  assert.deepEqual(await rollbackKeepBySlug("srv_3"), { app_web: 2 });
  assert.deepEqual(await rollbackKeepBySlug("srv_2"), { app_web: 2 });
  // A server outside the cluster is told nothing about it.
  assert.deepEqual(await rollbackKeepBySlug(SERVER_1), {});
});

test("a member that joins later gets the newest release on the next sweep", async () => {
  const cluster = await clusterWithApp(["srv_2", "srv_3"]);
  await copyReleaseToMembers("app_web", REL1, "srv_2");
  await asAdmin(() => addClusterMember(cluster.id, "srv_4"));
  assert.deepEqual(await asAdmin(() => listClusterImageProgress(cluster.id)), [
    { appId: "app_web", appName: "app_web", held: 2, total: 3 },
  ]);
  hostOf("srv_2").imageCopies.length = 0;
  await reconcileClusterImages();
  assert.deepEqual(
    hostOf("srv_2").imageCopies.map((c) => c.targetFingerprint),
    ["4".repeat(64)],
  );
  assert.deepEqual(
    await asAdmin(() => listClusterImageProgress(cluster.id)),
    [],
  );
});

test("each member keeps the last two releases: what the agent pruned is forgotten, and the source follows the same rule", async () => {
  await clusterWithApp();
  await copyReleaseToMembers("app_web", REL1, "srv_2");
  await new Promise((r) => setTimeout(r, 5));
  await copyReleaseToMembers("app_web", REL2, "srv_2");
  await new Promise((r) => setTimeout(r, 5));
  hostOf("srv_2").imageCopy = () => ({
    alreadyPresent: false,
    bytes: 5,
    pruned: [REL1],
  });
  await copyReleaseToMembers("app_web", REL3, "srv_2");

  const all = await rows();
  for (const server of ["srv_2", "srv_3", "srv_4"])
    assert.deepEqual(
      all.filter((r) => r.serverId === server).map((r) => r.imageRef),
      [REL2, REL3],
      server,
    );
  assert.ok(hostOf("srv_2").imageCopies.every((c) => c.keep === 2));
});

test("an agent too old to copy images is named on the member's row, and nothing else is stopped", async () => {
  await clusterWithApp();
  hostOf("srv_2").capabilities = hostOf("srv_2").capabilities.filter(
    (c) => c !== "cluster.images",
  );
  await copyReleaseToMembers("app_web", REL1, "srv_2");
  const failed = (await rows()).filter((r) => r.state === "failed");
  assert.equal(failed.length, 2);
  assert.match(failed[0]!.error, /too old to copy images/);
  assert.deepEqual(hostOf("srv_2").imageCopies, []);
});

test("while a Deplo move freezes the instance no copy is asked for, in a deploy or a sweep", async () => {
  const cluster = await clusterWithApp();
  await copyReleaseToMembers("app_web", REL1, "srv_2");
  hostOf("srv_2").imageCopies.length = 0;
  await db
    .delete(clusterImageCopies)
    .where(eq(clusterImageCopies.serverId, "srv_3"));
  await db.insert(deploMoves).values({
    id: "dmv_1",
    side: "target",
    state: "copying",
    startedBy: USER_1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  invalidateFrozen();

  await copyReleaseToMembers("app_web", REL2, "srv_2");
  await reconcileClusterImages();
  copyImageAfterDeploy("nothing", "srv_2");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(hostOf("srv_2").imageCopies, []);
  assert.equal(
    (await rows()).some((r) => r.imageRef === REL2),
    false,
  );
  assert.ok(cluster.id);
});

test("the progress line is the team's own: another team sees none of its Apps, and a cluster elsewhere shows none", async () => {
  const cluster = await clusterWithApp();
  hostOf("srv_2").imageCopy = () => {
    throw new Error("offline");
  };
  await copyReleaseToMembers("app_web", REL1, "srv_2");

  assert.equal(
    (await asAdmin(() => listClusterImageProgress(cluster.id))).length,
    1,
  );
  assert.deepEqual(
    await asTeamB(() => listClusterImageProgress(cluster.id)),
    [],
  );
});

test("an App that leaves its cluster, or is deleted, drops its holdings", async () => {
  await clusterWithApp();
  await copyReleaseToMembers("app_web", REL1, "srv_2");
  assert.equal((await rows()).length, 3);
  await clearPlacement("app", "app_web");
  assert.deepEqual(await rows(), []);

  await copyReleaseToMembers("app_web", REL1, "srv_2");
  await db.delete(appsTable).where(eq(appsTable.id, "app_web"));
  assert.deepEqual(await rows(), []);
});

test("a source that is not a member of the App's cluster copies nothing", async () => {
  await clusterWithApp(["srv_2", "srv_3"]);
  await copyReleaseToMembers("app_web", REL1, "srv_4");
  await copyReleaseToMembers("app_web", REL1, SERVER_1);
  assert.deepEqual(await rows(), []);
  for (const h of Object.values(hosts)) assert.deepEqual(h.imageCopies, []);
});
