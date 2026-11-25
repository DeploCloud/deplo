import { before, after, beforeEach, afterEach } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
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
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import { __resetReleaseCacheForTests } from "../agent/release";
import { invalidateFrozen } from "./deplo-move/freeze";
import { createCluster } from "./clusters/manage";
import { addClusterMember, listClusterMembers } from "./clusters/members";
import { getClusterById } from "./clusters/roster";
import { forgetLeaderRoster } from "./clusters/leader-sync";
import { watchClusterOnce } from "./clusters/watch";
import { turnOnExperiments } from "./experiments-test-helpers";

export let db: TestDb;
export let pg: PGlite;
export let fleet: ReturnType<typeof fakeClusterHosts>;
export let leader: FakeClusterHost;
export let rosterCalls: Record<string, unknown>[];
export let snapshot: unknown;
export let rosterRefusal: string;
export const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

export const setSnapshot = (v: unknown) => void (snapshot = v);
export const setRosterRefusal = (v: string) => void (rosterRefusal = v);

/** One leader on SERVER_1 and two more servers, set up again before every test of the file that calls it. */
export function watchFixture(): void {
  let origIp: string | undefined;
  before(async () => {
    origIp = process.env.DEPLO_SERVER_IP;
    ({ db, pg } = await makeTestDb());
    __setTestDb(db);
  });

  after(async () => {
    __resetTestDb();
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
      truncate table deplo_moves, clusters, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
    await seedIdentity(db, {
      users: [
        { id: USER_1, teamId: TEAM_A, role: "owner" },
        { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
      ],
    });
    await turnOnExperiments(db, "clusters");
    await seedServer(db, undefined, { deploHost: true });
    process.env.DEPLO_SERVER_IP = "10.0.0.1";
    for (const [i, id] of ["srv_2", "srv_3"].entries()) {
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
    invalidateFrozen();
    forgetLeaderRoster();
    rosterCalls = [];
    snapshot = { head: 0, clusters: {} };
    rosterRefusal = "";
    fleet = fakeClusterHosts();
    leader = fleet.host(SERVER_1, {
      status: {
        installed: true,
        running: true,
        version: "0.2.0",
        relay: true,
        member: false,
        relayLinks: 0,
      },
      leader: (method, payload) => {
        if (method === "leader.roster") {
          if (rosterRefusal) throw new Error(rosterRefusal);
          rosterCalls.push(JSON.parse(new TextDecoder().decode(payload)));
          return enc({ ok: true });
        }
        if (method === "leader.snapshot") return enc(snapshot);
        return payload;
      },
    });
    for (const id of ["srv_2", "srv_3"]) fleet.host(id);
    __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
    __resetReleaseCacheForTests();
  });

  afterEach(() => {
    fleet.restore();
    __setClusterPinForTest(null);
    __resetReleaseCacheForTests();
    if (origIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = origIp;
  });
}

export const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
export const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

export async function eu(allTeams = true) {
  const cluster = await asAdmin(() =>
    createCluster("eu", { allTeams, teamIds: allTeams ? [] : [TEAM_A] }),
  );
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
  return cluster;
}

export async function inCluster(clusterId: string, id: string, server: string) {
  await seedApp(db, { id, serverId: server });
  await db.update(appsTable).set({ clusterId }).where(eq(appsTable.id, id));
}

export async function stored(clusterId: string) {
  const c = await getClusterById(clusterId);
  return { seq: c!.eventSeq, epoch: c!.leaderEpoch };
}

export async function states(clusterId: string) {
  return Object.fromEntries(
    (await asAdmin(() => listClusterMembers(clusterId))).map((m) => [
      m.serverId,
      m.leaseState,
    ]),
  );
}

export const activityTexts = async () =>
  (
    await db
      .select()
      .from(activities)
      .orderBy(activities.createdAt, activities.seq)
  )
    .map((a) => a.message)
    .filter((m) =>
      /not responding|answers again|stopped responding|Too few servers/.test(m),
    );

/** Runs a watch until the stored sequence reaches `until`, then drops the leader's end of it. */
export async function watchUntil(clusterId: string, until: number) {
  const done = watchClusterOnce(clusterId);
  for (let i = 0; i < 200 && (await stored(clusterId)).seq < until; i++)
    await new Promise((r) => setTimeout(r, 10));
  // Let the reconcile that follows the last event finish before the leader hangs up.
  for (let i = 0; i < 50 && rosterCalls.length === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  leader.watch.drop();
  return done;
}
