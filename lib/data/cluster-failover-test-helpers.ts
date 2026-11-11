import { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

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
import { workloadPlacements } from "../db/schema/control-plane/clusters";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __resetQueueForTest } from "../deploy/deploy-queue";
import { __resetCooldowns } from "../notify/cooldown";
import type { FetchCapture } from "../notify/fetch-capture-test-helpers";
import { invalidateFrozen } from "./deplo-move/freeze";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { forgetLeaderRoster } from "./clusters/leader-sync";
import {
  applyLeaderEvent,
  watchClusterOnce,
  type LeaderEvent,
} from "./clusters/watch";
import { renderCompose } from "../deploy/build/compose-render";
import { getClusterById } from "./clusters/roster";

export const AT = "2026-01-01T00:00:00.000Z";
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** A two-member cluster "eu" behind the fake agents, and what a failover test reads back; registers the hooks. */
export function failoverLab() {
  let pg: PGlite;
  let fleet: ReturnType<typeof fakeClusterHosts>;
  const origIp = process.env.DEPLO_SERVER_IP;
  const lab = {
    db: undefined as unknown as TestDb,
    leader: undefined as unknown as FakeClusterHost,
    members: {} as Record<string, FakeClusterHost>,
    /** Every call the leader was forwarded, in order. */
    calls: [] as { method: string; body: Record<string, unknown> }[],
    /** What the leader answers `leader.snapshot`. */
    snapshot: { head: 0, clusters: {} } as unknown,
    capture: null as FetchCapture | null,
    /** The sequence of the last event `event()` made. */
    seq: 0,
  };

  before(async () => {
    const made = await makeTestDb();
    lab.db = made.db;
    pg = made.pg;
    __setTestDb(lab.db);
  });

  after(async () => {
    __resetTestDb();
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
      truncate table deplo_moves, clusters, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
    await seedIdentity(lab.db, {
      users: [
        { id: USER_1, teamId: TEAM_A, role: "owner" },
        { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
      ],
    });
    await seedServer(lab.db);
    process.env.DEPLO_SERVER_IP = "10.0.0.1";
    for (const [i, id] of ["srv_2", "srv_3"].entries()) {
      await seedServerRow(lab.db, {
        id,
        name: `server-${id.slice(-1)}`,
        ip: `10.0.0.${i + 2}`,
        host: `10.0.0.${i + 2}`,
      });
      await lab.db
        .update(serversTable)
        .set({
          agentCertFingerprint: String(i + 2).repeat(64),
          hostArch: "amd64",
          memoryMb: 2048,
        })
        .where(eq(serversTable.id, id));
    }
    await lab.db
      .update(serversTable)
      .set({ agentCertFingerprint: "1".repeat(64) })
      .where(eq(serversTable.id, SERVER_1));
    invalidateFrozen();
    forgetLeaderRoster();
    lab.calls = [];
    lab.snapshot = { head: 0, clusters: {} };
    fleet = fakeClusterHosts();
    lab.leader = fleet.host(SERVER_1, {
      status: {
        installed: true,
        running: true,
        version: "0.2.0",
        relay: true,
        member: false,
        relayLinks: 0,
      },
      leader: (method, payload) => {
        lab.calls.push({
          method,
          body: JSON.parse(new TextDecoder().decode(payload) || "{}"),
        });
        if (method === "placement.place") return enc({ member: "srv_3" });
        if (method === "leader.snapshot") return enc(lab.snapshot);
        return enc({ ok: true });
      },
    });
    for (const id of ["srv_2", "srv_3"]) lab.members[id] = fleet.host(id);
    __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
    __resetReleaseCacheForTests();
    __resetCooldowns();
  });

  afterEach(() => {
    lab.capture?.restore();
    lab.capture = null;
    fleet.restore();
    __resetQueueForTest();
    __setClusterPinForTest(null);
    __resetReleaseCacheForTests();
    if (origIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = origIp;
  });

  const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

  async function eu() {
    const cluster = await asAdmin(() =>
      createCluster("eu", { allTeams: true, teamIds: [] }),
    );
    await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
    await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
    return cluster;
  }

  async function web(clusterId: string, id = "prj_web", team = TEAM_A) {
    await seedApp(lab.db, { id, slug: id, serverId: "srv_2", teamId: team });
    await lab.db
      .update(appsTable)
      .set({ clusterId, name: id === "prj_web" ? "web" : id })
      .where(eq(appsTable.id, id));
    await lab.db.insert(workloadPlacements).values({
      kind: "app",
      workloadId: id,
      replica: 0,
      memberServerId: "srv_2",
      epoch: 1,
      updatedAt: AT,
    });
  }

  /** The App as the leader started it from its bundle: the stack is on that member, routed as it was. */
  function startedOn(serverId: string, id = "prj_web") {
    lab.members[serverId].stacks[id] = renderCompose({
      network: "deplo-team-team_test",
      name: `deplo-${id}`,
      image: "deplo/web:abc",
      port: 3000,
      appId: id,
      deployKey: id,
      routes: [],
      env: {},
    });
  }

  const autoDomain = (appId = "prj_web") =>
    lab.db.insert(domainsTable).values({
      id: `dom_${appId}`,
      appId,
      name: "web-word-0a000002.deplo.site",
      status: "valid",
      isPrimary: true,
      ssl: false,
      source: "auto",
      createdAt: AT,
    });

  const placedOn = async (id = "prj_web") =>
    (
      await lab.db
        .select()
        .from(workloadPlacements)
        .where(eq(workloadPlacements.workloadId, id))
    ).map((r) => r.memberServerId);

  /** What the leader's snapshot says after it moved Apps on its own. */
  function leaderMoved(
    clusterId: string,
    moves: { id: string; member: string; seq: number; wait?: string }[],
  ) {
    lab.snapshot = {
      head: 0,
      clusters: {
        [clusterId]: {
          epoch: 1,
          superseded: false,
          members: [
            { id: "srv_2", state: "fenced" },
            { id: "srv_3", state: "ok" },
          ],
          placement: moves.map((m) => ({
            kind: "app",
            id: m.id,
            replica: 0,
            member: m.member,
            slug: m.id,
            singleWriter: false,
          })),
          moves: moves.map((m) => ({
            kind: "app",
            id: m.id,
            replica: 0,
            member: m.member,
            slug: m.id,
            singleWriter: false,
            from: "srv_2",
            reason: "stopped_answering",
            seq: m.seq,
            ...(m.wait ? { wait: m.wait } : {}),
          })),
        },
      },
    };
  }

  /** Runs one watch until the stored sequence reaches `until` and the roster went back, then hangs up. */
  async function watchUntil(clusterId: string, until: number) {
    const done = watchClusterOnce(clusterId);
    const pushed = () => lab.calls.some((c) => c.method === "leader.roster");
    for (let i = 0; i < 300; i++) {
      const c = await getClusterById(clusterId);
      if (c!.eventSeq >= until && pushed()) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    lab.leader.watch.drop();
    return done;
  }

  const event = (
    cluster: string,
    type: string,
    data: Record<string, unknown>,
  ): LeaderEvent => ({ seq: ++lab.seq, type, cluster, data });

  async function apply(clusterId: string, ...es: LeaderEvent[]) {
    for (const e of es) {
      const r = await applyLeaderEvent(clusterId, e);
      assert.equal(r, "applied");
    }
  }

  const messages = async () =>
    (await lab.db.select().from(activities))
      .filter((a) => a.actor === "Deplo")
      .map((a) => ({ message: a.message, actor: a.actor }));

  return Object.assign(lab, {
    asAdmin,
    eu,
    web,
    startedOn,
    autoDomain,
    placedOn,
    leaderMoved,
    watchUntil,
    event,
    apply,
    messages,
  });
}
