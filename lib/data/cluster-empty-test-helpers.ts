import { before, after, beforeEach, afterEach } from "node:test";
import { gzipSync } from "node:zlib";

import type { PGlite } from "@electric-sql/pglite";
import { desc, eq } from "drizzle-orm";

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
import { seedServerRow } from "./infra-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { clusterMembers } from "../db/schema/control-plane/clusters";
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
import { createCluster } from "./clusters/manage";
import { addClusterMember, listClusterMembers } from "./clusters/members";
import { invalidateFrozen } from "./deplo-move/freeze";

// What the tests of emptying a cluster member share: members with a disk, a leader that places, and seeders.

export let db: TestDb;
export let pg: PGlite;
export let fleet: ReturnType<typeof fakeClusterHosts>;
export let origFetch: typeof fetch;
export const origIp = process.env.DEPLO_SERVER_IP;

export const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
export const COMPOSE =
  'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "80"\n';
export const MEMBERS = ["srv_2", "srv_3", "srv_4"];

// A gzipped tar with one file in it: what a volume with data exports.
export function tarWith(name: string, content: string): Buffer {
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
export const DATA = tarWith("data/real.db", "REAL");

// What a member's agent holds on disk: stacks by slug, volumes by name, and every call in order.
export interface Disk {
  stacks: Map<string, string>;
  volumes: Map<string, Buffer>;
  calls: string[];
  fail: Partial<Record<"import", string>>;
}
export const disks = new Map<string, Disk>();

export function diskOps(d: Disk): Partial<AgentConnection> {
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
export const setAnswer = (to: typeof answer) => {
  answer = to;
};
export const asked: Record<string, unknown>[] = [];
export const rosters: { members: Record<string, unknown>[] }[] = [];

/** Registers the lab: a fresh fleet of three members before each test. */
export function emptyLab(): void {
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
    asked.length = 0;
    rosters.length = 0;
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
}

export const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
export const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_member", teamId: TEAM_A }, fn);
export const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

/** An image App that runs on `serverId`, with its stack on that member's disk. */
export async function runningApp(
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
export async function eu(members = ["srv_2", "srv_3"]) {
  const cluster = await asAdmin(() =>
    createCluster("eu", { allTeams: true, teamIds: [] }),
  );
  for (const id of members)
    await asAdmin(() => addClusterMember(cluster.id, id));
  rosters.length = 0;
  return cluster;
}

export async function member(serverId: string) {
  const [r] = await db
    .select()
    .from(clusterMembers)
    .where(eq(clusterMembers.serverId, serverId));
  return r!;
}

export async function appRow(id: string) {
  const [r] = await db.select().from(appsTable).where(eq(appsTable.id, id));
  return r!;
}

export async function activity(teamId = TEAM_A) {
  const rows = await db
    .select({ message: activities.message, actor: activities.actor })
    .from(activities)
    .where(eq(activities.teamId, teamId))
    .orderBy(activities.seq);
  return rows.map((r) => `${r.actor}: ${r.message}`);
}

/** The card's view of one member, as an instance admin reads it. */
export async function card(clusterId: string, serverId: string) {
  const all = await asAdmin(() => listClusterMembers(clusterId));
  return all.find((m) => m.serverId === serverId)!;
}

/** What the deploy on the new member does when it ends well: marks it ready and carries the data over. */
export async function deployLands(appId: string) {
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
