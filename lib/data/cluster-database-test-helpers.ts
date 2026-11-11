import { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";

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
import {
  seedDatabase,
  seedDestination,
  seedRun,
  settleProvisioning,
  TRUNCATE_BACKUPS,
} from "./backup-test-helpers";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { workloadPlacements } from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import {
  __forgetMemberProbes,
  __setClusterPinForTest,
} from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import { invalidateFrozen } from "./deplo-move/freeze";
import type { FailoverBundle } from "./clusters/bundles";
import { flushDatabaseBundles } from "./clusters/database-bundles";
import { forgetLeaderRoster } from "./clusters/leader-sync";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { applyLeaderEvent, type LeaderEvent } from "./clusters/watch";

// What the tests of a database on a cluster share: the lab, its seeders and what they read back (#202).

export let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
export let host: Record<string, FakeClusterHost> = {};
export let leaderHost: FakeClusterHost;
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
export const AGE_IDENTITY =
  "AGE-SECRET-KEY-1QVJ9ZZZ8QKZ7EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXA";
const enc = new TextEncoder();
const dec = new TextDecoder();
const answer = (v: unknown) => enc.encode(JSON.stringify(v));
export const fp = (n: number) => String(n).repeat(64);

// The leader as the agent forwards to it: its age identity, the sealed bundles it holds, every roster it was sent.
export const leader = {
  identity: "",
  publicKey: "",
  held: new Map<string, { deploymentId: string; sealed: Uint8Array }>(),
  dropped: [] as string[],
  rosters: [] as { members: Record<string, unknown>[] }[],
  snapshot: { head: 0, clusters: {} } as unknown,
};

function leaderCalls(method: string, payload: Uint8Array): Uint8Array {
  const body = payload.length
    ? (JSON.parse(dec.decode(payload)) as Record<string, string>)
    : {};
  switch (method) {
    case "leader.key":
      return answer({ publicKey: leader.publicKey });
    case "leader.bundle.put":
      leader.held.set(`${body.kind}/${body.id}`, {
        deploymentId: body.deploymentId,
        sealed: Buffer.from(body.sealed, "base64"),
      });
      return answer({});
    case "leader.bundle.drop":
      leader.dropped.push(`${body.kind}/${body.id}`);
      leader.held.delete(`${body.kind}/${body.id}`);
      return answer({});
    case "leader.bundle.list":
      return answer({
        bundles: [...leader.held].map(([key, b]) => ({
          kind: key.split("/")[0],
          id: key.split("/")[1],
          deploymentId: b.deploymentId,
        })),
      });
    case "leader.roster":
      leader.rosters.push(
        body as unknown as { members: Record<string, unknown>[] },
      );
      return answer({ ok: true });
    case "leader.snapshot":
      return answer(leader.snapshot);
    case "placement.place":
      return answer({ member: "srv_2" });
  }
  return payload;
}

export async function open(key = "database/db_main"): Promise<FailoverBundle> {
  const age = await import("age-encryption");
  const d = new age.Decrypter();
  d.addIdentity(leader.identity);
  return JSON.parse(
    await d.decrypt(leader.held.get(key)!.sealed, "text"),
  ) as FailoverBundle;
}

/** Registers the hooks: three servers beside Deplo's own, fake agents on all four, and a leader that holds bundles. */
export function databaseLab(): void {
  before(async () => {
    ({ db, pg } = await makeTestDb());
    __setTestDb(db);
  });

  after(async () => {
    await settleProvisioning(db);
    __resetTestDb();
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(`${TRUNCATE_BACKUPS}${TRUNCATE_PROJECT_GRAPH}
      truncate table deplo_moves, clusters, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
    await seedIdentity(db, {
      users: [
        { id: USER_1, teamId: TEAM_A, role: "owner" },
        { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
      ],
    });
    await seedServer(db);
    process.env.DEPLO_SERVER_IP = "10.0.0.1";
    for (const [i, id] of ["srv_2", "srv_3", "srv_4"].entries()) {
      await seedServerRow(db, {
        id,
        name: id.replace("srv_", "server-"),
        ip: `10.0.0.${i + 2}`,
        host: `10.0.0.${i + 2}`,
      });
      await db
        .update(serversTable)
        .set({
          agentCertFingerprint: fp(i + 2),
          hostArch: "amd64",
          memoryMb: 2048,
        })
        .where(eq(serversTable.id, id));
    }
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: fp(1) })
      .where(eq(serversTable.id, SERVER_1));
    const age = await import("age-encryption");
    leader.identity = await age.generateX25519Identity();
    leader.publicKey = await age.identityToRecipient(leader.identity);
    leader.held = new Map();
    leader.dropped = [];
    leader.rosters = [];
    leader.snapshot = { head: 0, clusters: {} };
    invalidateFrozen();
    forgetLeaderRoster();
    __forgetMemberProbes();
    fleet = fakeClusterHosts();
    leaderHost = fleet.host(SERVER_1, {
      status: {
        installed: true,
        running: true,
        version: "0.2.0",
        relay: true,
        member: false,
        relayLinks: 0,
      },
      leader: leaderCalls,
    });
    host = {};
    for (const id of ["srv_2", "srv_3", "srv_4"]) {
      host[id] = fleet.host(id);
      host[id].capabilities.push("backup", "backup-store", "backup-encrypt-s3");
    }
    __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
    __resetReleaseCacheForTests();
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
  });

  afterEach(async () => {
    seq = 0;
    await flushDatabaseBundles();
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

export async function eu(members = ["srv_2", "srv_3"]) {
  const cluster = await asAdmin(() =>
    createCluster("eu", { allTeams: true, teamIds: [] }),
  );
  for (const m of members) await asAdmin(() => addClusterMember(cluster.id, m));
  return cluster;
}

/** A database "main" of the cluster, running on srv_2, as placing it there leaves it. */
export async function main(clusterId: string, teamId = TEAM_A, id = "db_main") {
  await seedDatabase(db, { id, name: "main", teamId, serverId: "srv_2" });
  await db
    .update(databasesTable)
    .set({ clusterId })
    .where(eq(databasesTable.id, id));
  await db.insert(workloadPlacements).values({
    kind: "database",
    workloadId: id,
    replica: 0,
    memberServerId: "srv_2",
    epoch: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

/** A finished backup of "main" in the team's bucket, started at 14:15 UTC. */
export async function backedUp(
  over: Partial<Parameters<typeof seedRun>[1]> = {},
  teamId = TEAM_A,
) {
  const destinationId = over.destinationId ?? "dst_s3";
  if (destinationId === "dst_s3")
    await seedDestination(db, { id: "dst_s3", name: "bucket", teamId }).catch(
      () => {},
    );
  await seedRun(db, {
    id: "brun_1",
    teamId,
    destinationId,
    databaseId: "db_main",
    objectKey: "deplo/team/database/db_main/brun_1.dump.gz.age",
    sha256: "abc123",
    startedAt: "2026-03-01T14:15:00.000Z",
    finishedAt: "2026-03-01T14:15:20.000Z",
    ...over,
  });
}

export const deploSaid = async (teamId = TEAM_A) =>
  (
    await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.teamId, teamId))
      .orderBy(asc(activitiesTable.seq))
  )
    .filter((a) => a.actor === "Deplo")
    .map((a) => a.message);

let seq = 0;
export const event = (
  cluster: string,
  type: string,
  data: Record<string, unknown>,
): LeaderEvent => ({ seq: ++seq, type, cluster, data });

export async function apply(clusterId: string, ...es: LeaderEvent[]) {
  for (const e of es)
    assert.equal(await applyLeaderEvent(clusterId, e), "applied");
}

export const puts = () =>
  leaderHost.calls.filter((c) => c.method === "leader.bundle.put").length;

// Today at 14:15 UTC, so the entry reads as the spec writes it whatever day the suite runs.
export const TODAY_1415 = `${new Date().toISOString().slice(0, 10)}T14:15:00.000Z`;

export const failedOver = (clusterId: string, to = "srv_3") => [
  event(clusterId, "placement", {
    kind: "database",
    workloadId: "db_main",
    members: [to],
    epoch: 1,
  }),
  event(clusterId, "failed_over", {
    kind: "database",
    workloadId: "db_main",
    from: "srv_2",
    to,
    reason: "stopped_answering",
    backupId: "brun_1",
    backupAt: TODAY_1415,
  }),
];

/** An App "web" of the cluster on `serverId`, in the same Environment as "main" (none: the team's own network). */
export async function web(clusterId: string, serverId: string) {
  await seedApp(db, { id: "prj_web", slug: "web", serverId });
  await db
    .update(appsTable)
    .set({ clusterId, name: "web" })
    .where(eq(appsTable.id, "prj_web"));
  await db.insert(workloadPlacements).values({
    kind: "app",
    workloadId: "prj_web",
    replica: 0,
    memberServerId: serverId,
    epoch: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

export const movedOrRestored = async () =>
  (await deploSaid()).filter((m) => /^(Restored|Moved) /.test(m));

export const last = (id: string) => host[id].forwarders.at(-1)!;

export const cannot = async () =>
  (await deploSaid()).filter((m) => /cannot fail over yet/.test(m));
