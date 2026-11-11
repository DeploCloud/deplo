import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import type { PGlite } from "@electric-sql/pglite";
import { and, desc, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  clusterMembers,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import type { AgentConnection } from "../infra/agent-client/connection";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import { fakeClusterHosts } from "../infra/agent-client/cluster-test-helpers";
import {
  __setRunnerForTest,
  __resetQueueForTest,
} from "../deploy/deploy-queue";
import { completePendingAppMigration } from "./app-migration";
import { createApp } from "./apps/create";
import { moveAppToCluster } from "./apps/source";
import {
  emptyClusterMember,
  runEmptyingPass,
  stopEmptyingClusterMember,
} from "./clusters/empty";
import { createCluster } from "./clusters/manage";
import {
  __resetClusterWatchForTest,
  releaseClusterWatchLease,
  runClusterWatchTick,
} from "./clusters/watch-scheduler";
import { addClusterMember, listClusterMembers } from "./clusters/members";
import {
  PlacementRefusedError,
  PlacementUnavailableError,
} from "./clusters/placement";
import { invalidateFrozen } from "./deplo-move/freeze";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const COMPOSE =
  'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "80"\n';
const MEMBERS = ["srv_2", "srv_3", "srv_4"];

// A gzipped tar with one file in it: what a volume with data exports.
function tarWith(name: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "latin1");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(
    content.length.toString(8).padStart(11, "0") + "\0",
    124,
    "latin1",
  );
  header.write("00000000000\0", 136, "latin1");
  header[156] = 0x30;
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  header.write("        ", 148, "latin1");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content, 0, "latin1");
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}
const DATA = tarWith("data/real.db", "REAL");

// What a member's agent holds on disk: stacks by slug, volumes by name, and every call in order.
interface Disk {
  stacks: Map<string, string>;
  volumes: Map<string, Buffer>;
  calls: string[];
  fail: Partial<Record<"import", string>>;
}
const disks = new Map<string, Disk>();

function diskOps(d: Disk): Partial<AgentConnection> {
  const ok = { ok: true, error: "" };
  const ops = {
    readStack: async (slug: string) => ({
      exists: d.stacks.has(slug),
      yaml: d.stacks.get(slug) ?? "",
    }),
    stopStack: async (slug: string) => {
      d.calls.push(`stop:${slug}`);
      return d.stacks.has(slug) ? ok : { ok: false, error: "no such stack" };
    },
    startStack: async (slug: string) => {
      d.calls.push(`start:${slug}`);
      return d.stacks.has(slug) ? ok : { ok: false, error: "no such stack" };
    },
    destroyStack: async (
      slug: string,
      removeVolumes?: boolean,
      reclaim?: string[],
    ) => {
      d.calls.push(`destroy:${slug}`);
      d.stacks.delete(slug);
      if (removeVolumes)
        for (const n of [...d.volumes.keys()])
          if (n.includes(slug)) d.volumes.delete(n);
      for (const n of reclaim ?? []) d.volumes.delete(n);
      return ok;
    },
    reroute: async (req: { slug: string; composeYaml: string }) => {
      d.calls.push(`reroute:${req.slug}`);
      d.stacks.set(req.slug, req.composeYaml);
      return ok;
    },
    volumeUsage: async (names: string[]) =>
      new Map(
        names
          .filter((n) => d.volumes.has(n))
          .map((n) => [n, d.volumes.get(n)!.length] as const),
      ),
    exportVolume: async function* (name: string) {
      d.calls.push(`export:${name}`);
      const v = d.volumes.get(name);
      if (!v)
        throw Object.assign(new Error(`5 NOT_FOUND: no such volume ${name}`), {
          code: 5,
        });
      yield v;
    },
    importVolume: async (
      name: string,
      _wipe: boolean,
      chunks: AsyncIterable<Buffer>,
    ) => {
      d.calls.push(`import:${name}`);
      const parts: Buffer[] = [];
      for await (const c of chunks) parts.push(Buffer.from(c));
      const none = { links: 0, special: 0, names: [] };
      if (d.fail.import)
        return {
          ok: false,
          error: d.fail.import,
          bytesWritten: 0,
          sha256: "",
          dropped: none,
        };
      d.volumes.set(name, Buffer.concat(parts));
      return { ...ok, bytesWritten: 0, sha256: "", dropped: none };
    },
    exportFiles: async function* () {
      yield gzipSync(Buffer.alloc(1024));
    },
    checkPort: async () => ({ available: true }),
    listInstances: async () => [],
  };
  return ops as unknown as Partial<AgentConnection>;
}

// What the leader answers a placement request, and every request it was asked.
let answer: (workload: Record<string, unknown>) => unknown = () => ({
  member: "srv_3",
});
let asked: Record<string, unknown>[] = [];
let rosters: { members: Record<string, unknown>[] }[] = [];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setRunnerForTest(async () => {});
});

after(async () => {
  // A queued deploy keeps the stubbed queue turning: empty it so nothing outlives this file.
  await pg.exec("truncate table deployments cascade");
  for (let i = 0; i < 20; i++) await pg.query("select 1");
  __resetTestDb();
  __resetQueueForTest();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters, databases, deplo_moves, pending_teardowns, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  invalidateFrozen();
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
      {
        id: "user_member",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "create_apps", "configure_apps"],
      },
    ],
  });
  await seedServer(db);
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  for (const [i, id] of MEMBERS.entries()) {
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
  answer = () => ({ member: "srv_3" });
  asked = [];
  rosters = [];
  const dec = (p: Uint8Array) => JSON.parse(new TextDecoder().decode(p));
  // The leader runs on Deplo's own machine, already installed.
  fleet.host(SERVER_1, {
    status: {
      installed: true,
      running: true,
      version: "0.2.0",
      relay: true,
      member: false,
      relayLinks: 0,
    },
    leader: (method, payload) => {
      if (method === "leader.roster") rosters.push(dec(payload));
      if (method === "leader.snapshot")
        return new TextEncoder().encode(JSON.stringify({ clusters: {} }));
      if (method !== "placement.place") return payload;
      const { workload } = dec(payload);
      asked.push(workload);
      return new TextEncoder().encode(JSON.stringify(answer(workload)));
    },
  });
  disks.clear();
  for (const id of MEMBERS) {
    const d: Disk = {
      stacks: new Map(),
      volumes: new Map(),
      calls: [],
      fail: {},
    };
    disks.set(id, d);
    fleet.host(id, { extra: diskOps(d) });
  }
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
});

afterEach(() => {
  fleet.restore();
  __setClusterPinForTest(null);
  __resetReleaseCacheForTests();
  globalThis.fetch = origFetch;
  if (origIp === undefined) delete process.env.DEPLO_SERVER_IP;
  else process.env.DEPLO_SERVER_IP = origIp;
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_member", teamId: TEAM_A }, fn);
const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

/** An image App that runs on `serverId`, with its stack on that member's disk. */
async function runningApp(
  id: string,
  serverId: string,
  opts: { teamId?: string; memoryMb?: number; createdAt?: string } = {},
) {
  await seedApp(db, {
    id,
    slug: id,
    source: "docker-image",
    serverId,
    teamId: opts.teamId,
  });
  await db
    .update(appsTable)
    .set({
      name: id,
      dockerImage: "nginx:1",
      repoUrl: null,
      repoRepo: null,
      resourceMemLimitMb: opts.memoryMb ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .where(eq(appsTable.id, id));
  disks
    .get(serverId)
    ?.stacks.set(id, "services:\n  app:\n    image: nginx:1\n");
}

/** Cluster "eu" of srv_2 and srv_3 (and srv_4 when asked), joined after the work above was seeded. */
async function eu(members = ["srv_2", "srv_3"]) {
  const cluster = await asAdmin(() =>
    createCluster("eu", { allTeams: true, teamIds: [] }),
  );
  for (const id of members)
    await asAdmin(() => addClusterMember(cluster.id, id));
  rosters = [];
  return cluster;
}

async function member(serverId: string) {
  const [r] = await db
    .select()
    .from(clusterMembers)
    .where(eq(clusterMembers.serverId, serverId));
  return r!;
}

async function appRow(id: string) {
  const [r] = await db.select().from(appsTable).where(eq(appsTable.id, id));
  return r!;
}

async function activity(teamId = TEAM_A) {
  const rows = await db
    .select({ message: activities.message, actor: activities.actor })
    .from(activities)
    .where(eq(activities.teamId, teamId))
    .orderBy(activities.seq);
  return rows.map((r) => `${r.actor}: ${r.message}`);
}

/** The card's view of one member, as an instance admin reads it. */
async function card(clusterId: string, serverId: string) {
  const all = await asAdmin(() => listClusterMembers(clusterId));
  return all.find((m) => m.serverId === serverId)!;
}

/** What the deploy on the new member does when it ends well: marks it ready and carries the data over. */
async function deployLands(appId: string) {
  const app = await appRow(appId);
  const [dep] = await db
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.appId, appId))
    .orderBy(desc(deploymentsTable.createdAt))
    .limit(1);
  disks
    .get(app.serverId)
    ?.stacks.set(app.slug, "services:\n  app:\n    image: nginx:1\n");
  await db
    .update(deploymentsTable)
    .set({ status: "ready", readyAt: new Date().toISOString() })
    .where(eq(deploymentsTable.id, dep!.id));
  return completePendingAppMigration(appId, app.serverId, () => {});
}

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

test(
  "the roster the leader gets marks the member as emptying",
  { todo: "holds once #198 merges: its member facts carry the flag" },
  async () => {
    await runningApp("web", "srv_2");
    const cluster = await eu();
    await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
    const sent = rosters.at(-1)!.members;
    assert.equal(sent.find((m) => m.id === "srv_2")?.emptying, true);
    assert.equal(sent.find((m) => m.id === "srv_3")?.emptying, false);
  },
);

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

async function deploymentsOf(appId: string) {
  return db
    .select({
      serverId: deploymentsTable.serverId,
      status: deploymentsTable.status,
      creator: deploymentsTable.creator,
    })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.appId, appId))
    .orderBy(deploymentsTable.createdAt);
}

async function placedOn(kind: string, id: string) {
  const rows = await db
    .select({ member: workloadPlacements.memberServerId })
    .from(workloadPlacements)
    .where(
      and(
        eq(workloadPlacements.kind, kind),
        eq(workloadPlacements.workloadId, id),
      ),
    );
  return rows.map((r) => r.member);
}

test("Apps move one at a time, each team sees its own move, and the server ends with none", async () => {
  await runningApp("api", "srv_2");
  await runningApp("web", "srv_2", { teamId: TEAM_B });
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));

  await runEmptyingPass();
  assert.deepEqual(
    asked.map((w) => [w.kind, w.id]),
    [["app", "api"]],
    "the leader picks the member, for one App only",
  );
  const api = await appRow("api");
  assert.equal(api.serverId, "srv_3");
  assert.equal(api.clusterId, cluster.id, "it stays on the cluster");
  assert.deepEqual(await deploymentsOf("api"), [
    { serverId: "srv_3", status: "queued", creator: "Deplo" },
  ]);
  assert.deepEqual(await placedOn("app", "api"), ["srv_3"]);
  assert.equal((await appRow("web")).serverId, "srv_2");
  assert.deepEqual((await card(cluster.id, "srv_2")).emptying, {
    since: (await member("srv_2")).emptyingSince,
    total: 2,
    left: 2,
    moving: "api",
    error: "",
  });

  await runEmptyingPass();
  assert.equal(asked.length, 1, "nothing else starts while api is deploying");

  assert.equal(await deployLands("api"), "nothing");
  await runEmptyingPass();
  assert.deepEqual(
    asked.map((w) => w.id),
    ["api", "web"],
  );
  assert.equal((await appRow("web")).serverId, "srv_3");
  const mid = (await card(cluster.id, "srv_2")).emptying!;
  assert.deepEqual([mid.total, mid.left, mid.moving], [2, 1, "web"]);
  assert.equal(
    (await activity(TEAM_B))[0],
    "Deplo: Moved web to srv_3: srv_2 is being emptied",
  );
  assert.ok(
    !(await activity()).some((a) => a.includes("web")),
    "another team's App is not in this team's Activity",
  );

  await deployLands("web");
  await runEmptyingPass();
  const done = (await card(cluster.id, "srv_2")).emptying!;
  assert.deepEqual([done.total, done.left, done.moving], [2, 0, ""]);
  assert.ok(
    (await member("srv_2")).emptyingSince,
    "it keeps taking no work until an admin says otherwise",
  );
  assert.equal(
    (await activity()).at(-1),
    "Deplo: Emptied server srv_2 of cluster eu",
  );
  await runEmptyingPass();
  assert.equal(
    (await activity()).filter((a) => a.includes("Emptied")).length,
    1,
    "said once",
  );
});

test("an App's stored data is copied to the server it moves to, since the old one is alive", async () => {
  await runningApp("blog", "srv_2");
  await pg.exec(
    `insert into app_volumes (volume_id, app_id, position, type, name, mount_path, read_only)
       values ('vol_1', 'blog', 0, 'named', 'data', '/data', false)`,
  );
  const yaml =
    "services:\n  app:\n    image: nginx:1\n    volumes:\n      - deplo-blog-data:/data\nvolumes:\n  deplo-blog-data:\n    name: deplo-blog-data\n";
  disks.get("srv_2")!.stacks.set("blog", yaml);
  disks.get("srv_2")!.volumes.set("deplo-blog-data", DATA);
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  disks.get("srv_3")!.stacks.set("blog", yaml);
  assert.equal(await deployLands("blog"), "done");
  assert.deepEqual(disks.get("srv_3")!.volumes.get("deplo-blog-data"), DATA);
  assert.ok(!disks.get("srv_2")!.stacks.has("blog"), "the old stack is gone");
  await runEmptyingPass();
  assert.equal((await card(cluster.id, "srv_2")).emptying?.left, 0);
});

async function dbRow(id: string) {
  const [r] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, id));
  return r!;
}

/** A managed database running on `serverId` with data in its volume. */
async function runningDatabase(id: string, name: string, serverId: string) {
  await seedDatabase(db, { id, name, serverId });
  const d = disks.get(serverId)!;
  d.stacks.set(`db-${name}`, "services: {}\n");
  d.volumes.set(`deplo-db-${name}_db-${name}-data`, DATA);
}

test("a database moves first, with its data, and stays on the cluster", async () => {
  await runningDatabase("db_main", "main", "srv_2");
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();

  assert.deepEqual(
    asked.map((w) => [w.kind, w.id]),
    [
      ["database", "db_main"],
      ["app", "web"],
    ],
    "the database is whole before the first App starts moving",
  );
  const moved = await dbRow("db_main");
  assert.equal(moved.serverId, "srv_3");
  assert.equal(moved.clusterId, cluster.id);
  assert.deepEqual(await placedOn("database", "db_main"), ["srv_3"]);
  assert.deepEqual(
    disks.get("srv_3")!.volumes.get("deplo-db-main_db-main-data"),
    DATA,
    "the data was copied across",
  );
  assert.ok(!disks.get("srv_2")!.stacks.has("db-main"));
  assert.ok(
    (await activity()).includes(
      "Deplo: Moved database main to srv_3: srv_2 is being emptied",
    ),
  );
  const now = (await card(cluster.id, "srv_2")).emptying!;
  assert.deepEqual([now.total, now.left, now.moving], [2, 1, "web"]);
});

const NO_ROOM_FOR_WEB =
  "No server in cluster eu has 256 MB free. Add a server to it or lower web's memory.";

test("when the leader finds no room half-way, emptying stops with that sentence and goes on when asked to continue", async () => {
  await runningApp("api", "srv_2");
  await runningApp("web", "srv_2");
  const cluster = await eu();
  answer = (w) =>
    w.id === "web"
      ? {
          refusal: {
            reason: "no_room",
            neededMb: 256,
            cluster: cluster.id,
            workload: "web",
          },
        }
      : { member: "srv_3" };
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  await deployLands("api");
  await runEmptyingPass();

  const stopped = (await card(cluster.id, "srv_2")).emptying!;
  assert.deepEqual(
    [stopped.left, stopped.moving, stopped.error],
    [1, "", NO_ROOM_FOR_WEB],
  );
  assert.equal(
    (await activity()).at(-1),
    `Deplo: Stopped emptying server srv_2 of cluster eu: ${NO_ROOM_FOR_WEB}`,
  );
  assert.equal((await appRow("web")).serverId, "srv_2");
  assert.deepEqual(disks.get("srv_2")!.calls, ["destroy:api"]);

  await runEmptyingPass();
  assert.equal(asked.length, 2, "a stopped emptying asks nothing again");

  answer = () => ({ member: "srv_3" });
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  assert.equal(
    (await activity()).at(-1),
    "user_1: Continued emptying server srv_2 of cluster eu",
  );
  assert.equal((await card(cluster.id, "srv_2")).emptying?.error, "");
  await runEmptyingPass();
  assert.equal((await appRow("web")).serverId, "srv_3");
});

test("an App whose move was rolled back is not moved again in a loop", async () => {
  await runningApp("blog", "srv_2");
  await pg.exec(
    `insert into app_volumes (volume_id, app_id, position, type, name, mount_path, read_only)
       values ('vol_1', 'blog', 0, 'named', 'data', '/data', false)`,
  );
  const yaml =
    "services:\n  app:\n    image: nginx:1\n    volumes:\n      - deplo-blog-data:/data\nvolumes:\n  deplo-blog-data:\n    name: deplo-blog-data\n";
  disks.get("srv_2")!.stacks.set("blog", yaml);
  disks.get("srv_2")!.volumes.set("deplo-blog-data", DATA);
  disks.get("srv_3")!.fail.import = "disk full";
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  disks.get("srv_3")!.stacks.set("blog", yaml);
  assert.equal(await deployLands("blog"), "rolled-back");
  await runEmptyingPass();
  assert.equal((await appRow("blog")).serverId, "srv_2");
  assert.equal(
    (await card(cluster.id, "srv_2")).emptying?.error,
    "blog could not be moved, so it is still on this server. Its last deployment says why.",
  );
  await runEmptyingPass();
  assert.equal(asked.length, 1);
  assert.equal((await deploymentsOf("blog")).length, 1);
});

test("a deploy that fails on the new server stops emptying, and continuing deploys it again", async () => {
  await runningApp("api", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  await db
    .update(deploymentsTable)
    .set({ status: "error" })
    .where(eq(deploymentsTable.appId, "api"));
  await runEmptyingPass();
  assert.equal(
    (await card(cluster.id, "srv_2")).emptying?.error,
    "api did not finish moving to its new server. Its last deployment says why.",
  );
  assert.equal((await card(cluster.id, "srv_2")).emptying?.left, 1);

  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  assert.deepEqual(
    (await deploymentsOf("api")).map((d) => [d.status, d.creator]),
    [
      ["error", "Deplo"],
      ["queued", "Deplo"],
    ],
  );
  assert.equal(asked.length, 1, "the leader already chose where it goes");
  await deployLands("api");
  await runEmptyingPass();
  assert.equal((await card(cluster.id, "srv_2")).emptying?.left, 0);
});

test("after a restart in the middle, the next pass picks up what was cut off", async () => {
  await runningDatabase("db_main", "main", "srv_2");
  await runningApp("api", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  // Deplo went away while the database was being copied: the row still names it, and it never left.
  await db
    .update(clusterMembers)
    .set({ emptyingWorkload: "database:db_main" })
    .where(eq(clusterMembers.serverId, "srv_2"));
  await runEmptyingPass();
  assert.equal((await dbRow("db_main")).serverId, "srv_3");
  assert.equal((await appRow("api")).serverId, "srv_3");

  // Deplo went away again after api's deploy was ready and before its data was carried over.
  await db
    .update(deploymentsTable)
    .set({ status: "ready", readyAt: "2026-01-01T00:00:00.000Z" })
    .where(eq(deploymentsTable.appId, "api"));
  await runEmptyingPass();
  assert.deepEqual(
    (await deploymentsOf("api")).map((d) => d.status),
    ["ready", "queued"],
    "a new deploy carries the data",
  );
  assert.equal((await card(cluster.id, "srv_2")).emptying?.error, "");
  await deployLands("api");
  await runEmptyingPass();
  assert.equal((await card(cluster.id, "srv_2")).emptying?.left, 0);
});

test("stop emptying: the server takes work again and nothing else moves", async () => {
  await runningApp("api", "srv_2");
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  rosters = [];
  await asAdmin(() => stopEmptyingClusterMember(cluster.id, "srv_2"));
  assert.equal((await member("srv_2")).emptyingSince, null);
  assert.equal((await card(cluster.id, "srv_2")).emptying, null);
  assert.equal(
    (await activity()).at(-1),
    "user_1: Stopped emptying server srv_2 of cluster eu",
  );
  assert.equal(rosters.length, 1, "the leader is told");
  await deployLands("api");
  await runEmptyingPass();
  assert.equal(asked.length, 1);
  assert.equal((await appRow("web")).serverId, "srv_2");

  await asAdmin(() => stopEmptyingClusterMember(cluster.id, "srv_2"));
  assert.equal(
    (await activity()).filter((a) => a.includes("Stopped emptying")).length,
    1,
    "stopping twice says it once",
  );
});

test("nothing moves while a Deplo move freezes this instance", async () => {
  await runningApp("api", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await db.insert(deploMoves).values({
    id: "dmv_1",
    side: "target",
    state: "copying",
    peerUrl: "https://new.example.com",
    startedBy: USER_1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  invalidateFrozen();
  await runEmptyingPass();
  assert.deepEqual(asked, []);
  assert.equal((await appRow("api")).serverId, "srv_2");
});

test("while a server is being emptied nothing new is placed on it, whatever the leader answers", async () => {
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  answer = () => ({ member: "srv_2" });
  const refused = (e: unknown) =>
    e instanceof PlacementUnavailableError &&
    e.message ===
      "Cluster eu's leader named a server that is being emptied. Try again in a moment.";
  await assert.rejects(
    asMember(() =>
      createApp({
        name: "web",
        source: "compose",
        repo: null,
        compose: COMPOSE,
        deploy: false,
        clusterId: cluster.id,
      }),
    ),
    refused,
  );
  await runningApp("solo", SERVER_1);
  await assert.rejects(
    asAdmin(() => moveAppToCluster("solo", cluster.id)),
    refused,
  );
  assert.equal((await appRow("solo")).serverId, SERVER_1);
  assert.deepEqual(
    await db.select().from(workloadPlacements),
    [],
    "nothing was placed",
  );

  await asAdmin(() => stopEmptyingClusterMember(cluster.id, "srv_2"));
  const web = await asMember(() =>
    createApp({
      name: "web",
      source: "compose",
      repo: null,
      compose: COMPOSE,
      deploy: false,
      clusterId: cluster.id,
    }),
  );
  assert.equal((await appRow(web.id)).serverId, "srv_2");
});

test("the cluster tick is what drives emptying in the background", async () => {
  await runningApp("api", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  try {
    await runClusterWatchTick();
    // No timer: the stubbed deploy runner keeps the queue busy, and each read lets the pass move on.
    for (
      let i = 0;
      i < 5000 && (await appRow("api")).serverId !== "srv_3";
      i++
    );
    assert.equal((await appRow("api")).serverId, "srv_3");
  } finally {
    __resetClusterWatchForTest();
    await releaseClusterWatchLease();
    await runEmptyingPass();
  }
});
