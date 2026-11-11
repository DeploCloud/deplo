import { after, afterEach, before, beforeEach } from "node:test";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { __resetReleaseCacheForTests } from "../agent/release";
import { runWithIdentity } from "../auth/request-context";
import { __resetTestDb, __setTestDb } from "../db/client";
import { activities } from "../db/schema/control-plane/activity";
import {
  clusterLeaderKeys,
  failoverBundlePushes,
} from "../db/schema/control-plane/clusters";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { makeTestDb, type TestDb } from "../db/test-harness";
import {
  __resetQueueForTest,
  __setRunnerForTest,
} from "../deploy/deploy-queue";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import {
  seedDeployment,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { createApp } from "./apps/create";
import {
  flushFailoverBundles,
  pushFailoverBundle,
  type FailoverBundle,
} from "./clusters/bundles";
import { __resetLeaderChecksForTest } from "./clusters/leader-standby";
import { forgetLeaderRoster } from "./clusters/leader-sync";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { getClusterById } from "./clusters/roster";
import { invalidateFrozen } from "./deplo-move/freeze";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServerRow } from "./infra-test-helpers";

const enc = new TextEncoder();
const dec = new TextDecoder();
const answer = (v: unknown) => enc.encode(JSON.stringify(v));

type Roster = {
  cluster: string;
  epoch: number;
  members: { id: string }[];
  placement: unknown[];
};

/** A leader as the agent forwards to it: its own key, the bundles it holds, and the epoch rule of the real one. */
export interface TestLeader {
  identity: string;
  publicKey: string;
  held: Map<
    string,
    { cluster: string; deploymentId: string; sealed: Uint8Array }
  >;
  /** The epoch it holds for each cluster; an older roster is refused. */
  epochs: Map<string, number>;
  rosters: Roster[];
  /** The newest sequence of its event buffer, as its snapshot reports it. */
  head: number;
  calls: (method: string, payload: Uint8Array) => Uint8Array;
}

export async function newTestLeader(): Promise<TestLeader> {
  const age = await import("age-encryption");
  const identity = await age.generateX25519Identity();
  const l: TestLeader = {
    identity,
    publicKey: await age.identityToRecipient(identity),
    held: new Map(),
    epochs: new Map(),
    rosters: [],
    head: 0,
    calls(method, payload) {
      const body = payload.length
        ? (JSON.parse(dec.decode(payload)) as Record<string, string>)
        : {};
      if (method === "leader.key") return answer({ publicKey: l.publicKey });
      if (method === "leader.roster") {
        const r = body as unknown as Roster;
        if (r.epoch < (l.epochs.get(r.cluster) ?? 0))
          throw new Error("the leader holds a newer epoch");
        l.epochs.set(r.cluster, r.epoch);
        l.rosters.push(r);
        return answer({ ok: true });
      }
      if (method === "leader.snapshot")
        return answer({
          head: l.head,
          clusters: Object.fromEntries(
            [...l.epochs].map(([id, epoch]) => [
              id,
              { epoch, superseded: false, members: [], placement: [] },
            ]),
          ),
        });
      if (method === "leader.bundle.put") {
        l.held.set(body.id, {
          cluster: body.cluster,
          deploymentId: body.deploymentId,
          sealed: Buffer.from(body.sealed, "base64"),
        });
        return answer({});
      }
      if (method === "leader.bundle.drop") {
        l.held.delete(body.id);
        return answer({});
      }
      if (method === "leader.bundle.list")
        return answer({
          bundles: [...l.held]
            .filter(([, b]) => b.cluster === body.cluster)
            .map(([id, b]) => ({
              kind: "app",
              id,
              deploymentId: b.deploymentId,
            })),
        });
      if (method === "placement.place") return answer({ member: "srv_2" });
      return payload;
    },
  };
  return l;
}

/** Opens the bundle a leader holds with that leader's own identity; throws when it was sealed to another key. */
export async function openBundle(
  l: TestLeader,
  id: string,
): Promise<FailoverBundle> {
  const age = await import("age-encryption");
  const d = new age.Decrypter();
  d.addIdentity(l.identity);
  return JSON.parse(
    await d.decrypt(l.held.get(id)!.sealed, "text"),
  ) as FailoverBundle;
}

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const SERVERS = ["srv_2", "srv_3", "srv_4"];
const RUNNING = {
  installed: true,
  running: true,
  version: "0.2.0",
  relay: true,
  member: false,
  relayLinks: 0,
};
const everyone = { allTeams: true, teamIds: [] as string[] };

/** A server's proxy stack with no route of Deplo's in it. */
export const TRAEFIK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
networks:
  deplo:
    external: true
`;

const COMPOSE =
  'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "80"\n';

/** Every roster a host's relay was handed, in order. */
export const relayRosters = (h: FakeClusterHost) =>
  h.calls
    .filter((c) => c.method === "relay.roster")
    .map(
      (c) =>
        JSON.parse(dec.decode(c.payload)) as {
          cluster: string;
          parties: { fingerprint: string; role: string }[];
        },
    );

/**
 * The fleet the leader tests run on, set up before each test: Deplo's own machine (SERVER_1) with a running leader,
 * and srv_2, srv_3, srv_4, each with a fake agent and a leader of its own behind it.
 */
export function leaderLab() {
  let pg: PGlite;
  let fleet: ReturnType<typeof fakeClusterHosts>;
  let origFetch: typeof fetch;
  const origIp = process.env.DEPLO_SERVER_IP;
  const lab = {
    db: undefined as unknown as TestDb,
    hosts: {} as Record<string, FakeClusterHost>,
    leaders: {} as Record<string, TestLeader>,
  };

  before(async () => {
    ({ db: lab.db, pg } = await makeTestDb());
    __setTestDb(lab.db);
    __setRunnerForTest(async () => {});
  });

  after(async () => {
    __resetTestDb();
    __resetQueueForTest();
    await pg.close();
  });

  beforeEach(async () => {
    const db = lab.db;
    await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters, failover_bundle_pushes, activities, deplo_moves, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
    await seedIdentity(db, {
      users: [
        { id: USER_1, teamId: TEAM_A, role: "owner" },
        { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
      ],
    });
    await seedServer(db);
    process.env.DEPLO_SERVER_IP = "10.0.0.1";
    for (const [i, id] of SERVERS.entries()) {
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
    lab.hosts = {};
    lab.leaders = {};
    for (const id of [SERVER_1, ...SERVERS]) {
      const l = (lab.leaders[id] = await newTestLeader());
      lab.hosts[id] = fleet.host(id, {
        leader: l.calls,
        ...(id === SERVER_1 ? { status: RUNNING } : {}),
      });
    }
    __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
    __resetReleaseCacheForTests();
    forgetLeaderRoster();
    __resetLeaderChecksForTest();
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
    invalidateFrozen();
  });

  afterEach(async () => {
    await flushFailoverBundles();
    fleet.restore();
    __setClusterPinForTest(null);
    __resetReleaseCacheForTests();
    globalThis.fetch = origFetch;
    if (origIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = origIp;
    invalidateFrozen();
  });

  const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
  const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

  /** Cluster eu with srv_2 and srv_3 in it, led from Deplo's machine. */
  async function eu() {
    const cluster = await asAdmin(() => createCluster("eu", everyone));
    await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
    await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
    return cluster;
  }

  const messages = async (teamId = TEAM_A) =>
    (
      await lab.db
        .select()
        .from(activities)
        .where(eq(activities.teamId, teamId))
        .orderBy(activities.seq)
    ).map((a) => `${a.actor}: ${a.message}`);

  const clusterApp = (clusterId: string) =>
    asAdmin(() =>
      createApp({
        name: "web",
        source: "compose",
        repo: null,
        compose: COMPOSE,
        deploy: false,
        clusterId,
      }),
    );

  /** What a successful deploy leaves behind: a ready deployment and its bundle at every leader. */
  async function deployed(app: { id: string; slug: string }, deployId: string) {
    await seedDeployment(lab.db, {
      id: deployId,
      appId: app.id,
      status: "ready",
    });
    await pushFailoverBundle({
      appId: app.id,
      deploymentId: deployId,
      stack: {
        slug: app.slug,
        projectId: app.id,
        imageRef: "nginx:1.27",
        composeYaml: COMPOSE,
        network: "deplo-team-x",
        env: { API_KEY: "k-123" },
        registryAuth: [],
        composeUpArgs: [],
      },
    });
  }

  /** The key each leader of the cluster is known by; `deplo` is the one on Deplo's machine. */
  const keyOwners = async (clusterId: string) =>
    Object.fromEntries(
      (
        await lab.db
          .select()
          .from(clusterLeaderKeys)
          .where(eq(clusterLeaderKeys.clusterId, clusterId))
      ).map((k) => [k.serverId ?? "deplo", k.publicKey]),
    );

  /** The key fingerprints whose leader acknowledged the App's bundle. */
  const pushedTo = async (appId: string) =>
    (
      await lab.db
        .select()
        .from(failoverBundlePushes)
        .where(eq(failoverBundlePushes.workloadId, appId))
    )
      .filter((r) => r.pushedAt)
      .map((r) => r.keyFingerprint)
      .sort();

  const stored = async (clusterId: string) => {
    const c = (await getClusterById(clusterId))!;
    return {
      server: c.leaderServerId,
      takenOver: c.leaderTakeoverAt !== null,
      epoch: c.leaderEpoch,
    };
  };

  return Object.assign(lab, {
    asAdmin,
    asTeamB,
    eu,
    messages,
    clusterApp,
    deployed,
    keyOwners,
    pushedTo,
    stored,
  });
}
