import { before, after, beforeEach, afterEach } from "node:test";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { encryptSecret } from "../crypto";
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
import {
  clusterImageCopies,
  clusterLeaderKeys,
  clusters as clustersTable,
  failoverBundlePushes,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import {
  __setRunnerForTest,
  __resetQueueForTest,
} from "../deploy/deploy-queue";
import { withPanelRoute } from "../deploy/traefik-stack";
import { createCluster } from "./clusters/manage";
import { addClusterMember, listClusterMembers } from "./clusters/members";
import { invalidateFrozen } from "./deplo-move/freeze";

let handle: TestDb;
let pg: PGlite;
/** The database of the test that runs now. */
export const db = (): TestDb => handle;
let fleet: ReturnType<typeof fakeClusterHosts>;
export const hosts: Record<string, FakeClusterHost> = {};
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
export const MEMBERS = ["srv_2", "srv_3", "srv_4"];
export const FP: Record<string, string> = {
  [SERVER_1]: "1".repeat(64),
  srv_2: "2".repeat(64),
  srv_3: "3".repeat(64),
  srv_4: "4".repeat(64),
};
export const everyone = { allTeams: true, teamIds: [] as string[] };
const enc = new TextEncoder();
export const dec = new TextDecoder();
const answer = (v: unknown) => enc.encode(JSON.stringify(v));

const TRAEFIK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com
networks:
  deplo:
    external: true
`;
const STACK = withPanelRoute(TRAEFIK, {
  domain: "deplo.example.com",
  fallbackDomain: "deplo-cb00710a.deplo.site",
  https: true,
  certResolver: "letsencrypt",
  target: "http://deplo:3000",
});

export const RUNNING = {
  installed: true,
  running: true,
  version: "0.2.0",
  relay: true,
  member: false,
  relayLinks: 0,
};

// What one leader was told, by method: every roster, every bundle dropped, every cluster it was told to forget.
export interface Told {
  rosters: {
    cluster: string;
    members: { id: string; fingerprint: string }[];
  }[];
  dropped: string[];
  forgotten: string[];
  /** The clusters its snapshot names: what it still serves. */
  serving: string[];
}
export const told: Record<string, Told> = {};

export function leaderOn(
  serverId: string,
  over: Partial<FakeClusterHost> = {},
) {
  const t: Told = { rosters: [], dropped: [], forgotten: [], serving: [] };
  told[serverId] = t;
  hosts[serverId] = fleet.host(serverId, {
    status: { ...RUNNING },
    leader: (method, payload) => {
      const body = payload.length ? JSON.parse(dec.decode(payload)) : {};
      if (method === "leader.roster") t.rosters.push(body);
      if (method === "leader.forget") t.forgotten.push(body.cluster);
      if (method === "leader.bundle.drop") t.dropped.push(body.id);
      if (method === "leader.snapshot")
        return answer({
          clusters: Object.fromEntries(t.serving.map((id) => [id, {}])),
        });
      if (method === "leader.key")
        return answer({ publicKey: `age1${serverId}` });
      if (method === "leader.bundle.list") return answer({ bundles: [] });
      if (method === "placement.place") return answer({ member: "srv_2" });
      return answer({ ok: true });
    },
    ...over,
  });
  return hosts[serverId];
}

/** Registers the hooks every cluster-dissolve test file runs under: one database, a fresh fleet per test. */
export function dissolveHarness(): void {
  before(async () => {
    ({ db: handle, pg } = await makeTestDb());
    __setTestDb(handle);
    __setRunnerForTest(async () => {});
  });

  after(async () => {
    __resetTestDb();
    __resetQueueForTest();
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
      truncate table clusters, failover_bundle_pushes, workload_placements, databases, backups, backup_destination, pending_teardowns, dns_providers, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;
      delete from instance_settings;`);
    invalidateFrozen();
    await seedIdentity(db(), {
      users: [
        { id: USER_1, teamId: TEAM_A, role: "owner" },
        { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
        { id: "user_member", teamId: TEAM_A, role: "member" },
      ],
    });
    await seedServer(db());
    process.env.DEPLO_SERVER_IP = "10.0.0.1";
    for (const [i, id] of MEMBERS.entries())
      await seedServerRow(db(), {
        id,
        ip: `10.0.0.${i + 2}`,
        host: `10.0.0.${i + 2}`,
      });
    for (const [id, fp] of Object.entries(FP))
      await db()
        .update(serversTable)
        .set({ agentCertFingerprint: fp })
        .where(eq(serversTable.id, id));
    fleet = fakeClusterHosts();
    for (const id of Object.keys(hosts)) delete hosts[id];
    for (const id of Object.keys(told)) delete told[id];
    // The leader and the relay run on Deplo's own machine, whose proxy carries the panel's route.
    leaderOn(SERVER_1, { proxy: { yaml: STACK, applied: 0, refuse: "" } });
    for (const id of MEMBERS) hosts[id] = fleet.host(id);
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

/** An image App that runs on `serverId`, seeded before its server joins a cluster. */
export async function runningApp(
  id: string,
  serverId: string,
  teamId = TEAM_A,
) {
  await seedApp(db(), {
    id,
    slug: id,
    source: "docker-image",
    serverId,
    teamId,
  });
  await db()
    .update(appsTable)
    .set({ name: id, dockerImage: "nginx:1", repoUrl: null, repoRepo: null })
    .where(eq(appsTable.id, id));
}

/** Cluster `name` of the given servers, joined after the work above was seeded. */
export async function clusterOf(name: string, members: string[]) {
  const cluster = await asAdmin(() => createCluster(name, everyone));
  for (const id of members)
    await asAdmin(() => addClusterMember(cluster.id, id));
  for (const t of Object.values(told)) t.rosters.length = 0;
  for (const h of Object.values(hosts)) h.memberCalls.length = 0;
  return cluster;
}

export const memberIds = async (clusterId: string) =>
  (await asAdmin(() => listClusterMembers(clusterId))).map((m) => m.serverId);

export const relayRosters = (h: FakeClusterHost) =>
  h.calls
    .filter((c) => c.method === "relay.roster")
    .map((c) => JSON.parse(dec.decode(c.payload)));

export async function activity(teamId = TEAM_A) {
  const rows = await db()
    .select({ message: activities.message, actor: activities.actor })
    .from(activities)
    .where(eq(activities.teamId, teamId))
    .orderBy(activities.seq);
  return rows.map((r) => `${r.actor}: ${r.message}`);
}

export async function appRow(id: string) {
  const [r] = await db().select().from(appsTable).where(eq(appsTable.id, id));
  return r!;
}

/** What the cluster keeps about a workload besides the row itself: where it is placed, its bundle and its image copies. */
export async function seedClusterState(clusterId: string, appId: string) {
  await db()
    .insert(clusterLeaderKeys)
    .values({
      clusterId,
      publicKey: `age1${SERVER_1}`,
      serverId: null,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
  await db()
    .insert(failoverBundlePushes)
    .values({
      workloadKind: "app",
      workloadId: appId,
      keyFingerprint: "abcd",
      deploymentId: "dpl_1",
      bundleEnc: encryptSecret("{}"),
      pushedAt: new Date().toISOString(),
    });
  await db()
    .insert(clusterImageCopies)
    .values({
      appId,
      imageRef: `deplo/${appId}:dpl_1`,
      serverId: "srv_2",
      state: "held",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
}

export const placementsOf = (id: string) =>
  db()
    .select()
    .from(workloadPlacements)
    .where(eq(workloadPlacements.workloadId, id));
export const pushesOf = (id: string) =>
  db()
    .select()
    .from(failoverBundlePushes)
    .where(eq(failoverBundlePushes.workloadId, id));
export const copiesOf = (id: string) =>
  db()
    .select()
    .from(clusterImageCopies)
    .where(eq(clusterImageCopies.appId, id));

export async function dbRow(id: string) {
  const [r] = await db()
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, id));
  return r!;
}

export async function server(id: string) {
  const [r] = await db()
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, id));
  return r!;
}

export const clusterNames = async () =>
  (await db().select().from(clustersTable)).map((c) => c.name);

/** Places `appId` as the leader reports it: one entry per replica, null for one waiting for room. */
export async function placed(appId: string, members: (string | null)[]) {
  await db()
    .delete(workloadPlacements)
    .where(eq(workloadPlacements.workloadId, appId));
  await db()
    .insert(workloadPlacements)
    .values(
      members.map((m, replica) => ({
        kind: "app",
        workloadId: appId,
        replica,
        memberServerId: m,
        epoch: 1,
        updatedAt: new Date().toISOString(),
      })),
    );
}
