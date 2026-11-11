import "server-only";

import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusterMembers as membersTable } from "../../db/schema/control-plane/clusters";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { startDeployment } from "../../deploy/build/deploy-start";
import { movePreviewsOff } from "../../deploy/preview-lifecycle/cluster-member";
import { nowIso } from "../../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import type { Cluster } from "../../types/cluster";
import { recordActivity } from "../activity";
import { relocateClusterApp } from "../apps/source";
import { relocateClusterDatabase } from "../databases/server-move";
import { instanceFrozen } from "../deplo-move/freeze";
import { hasPendingLock } from "../keyed-mutex";
import { getServerById } from "../servers/roster";
import { pushLeaderRoster } from "./leader-sync";
import { listMemberWorkloads, type MemberWorkload } from "./member-workloads";
import {
  askLeaderToPlace,
  listWorkloadPlacements,
  PlacementRefusedError,
  recordPlacement,
  refusalSentence,
} from "./placement";
import { getClusterById } from "./roster";

// https://deplo.build/docs/operations/clusters#empty-a-server

const ACTOR = "Deplo";

async function memberOf(clusterId: string, serverId: string) {
  const [row] = await getDb()
    .select()
    .from(membersTable)
    .where(
      and(
        eq(membersTable.clusterId, clusterId),
        eq(membersTable.serverId, serverId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function admin(clusterId: string, serverId: string) {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const server = await getServerById(serverId);
  const member = server && (await memberOf(clusterId, serverId));
  if (!server || !member)
    throw new Error(
      `${server?.name ?? "That server"} is not in cluster ${cluster.name}.`,
    );
  return { teamId, user, cluster, server, member };
}

// ponytail: the floor the leader's rule uses; one constant with #198's facts.ts once both are merged.
const MIN_WORKLOAD_MB = 256;
const needMb = (w: MemberWorkload) => Math.max(w.limitMb, MIN_WORKLOAD_MB);

/**
 * Refuses with the room sentence unless the other members can take everything `serverId` holds.
 * ponytail: memory limits summed here, most free first like the leader; the leader still picks each member.
 */
async function assertRoomElsewhere(
  cluster: Cluster,
  serverId: string,
  held: MemberWorkload[],
): Promise<void> {
  const toMove = held.filter((w) => !w.leaving);
  if (toMove.length === 0) return;
  const others = await getDb()
    .select({ id: membersTable.serverId, memoryMb: serversTable.memoryMb })
    .from(membersTable)
    .innerJoin(serversTable, eq(serversTable.id, membersTable.serverId))
    .where(
      and(
        eq(membersTable.clusterId, cluster.id),
        ne(membersTable.serverId, serverId),
        isNull(membersTable.emptyingSince),
        eq(membersTable.leaseState, "ok"),
        ne(serversTable.status, "offline"),
      ),
    );
  const refuse = (reason: "no_room" | "no_member_online", w: MemberWorkload) =>
    new PlacementRefusedError(
      { reason, neededMb: needMb(w), cluster: cluster.id, workload: w.id },
      refusalSentence(
        { reason, neededMb: needMb(w), cluster: cluster.id, workload: w.id },
        { cluster: cluster.name, workload: w.name },
      ),
    );
  if (others.length === 0) throw refuse("no_member_online", toMove[0]!);
  const free = new Map<string, number>();
  for (const o of others) {
    const used = (await listMemberWorkloads(o.id))
      .filter((w) => !w.leaving)
      .reduce((n, w) => n + needMb(w), 0);
    free.set(o.id, Math.max(o.memoryMb - used, 0));
  }
  for (const w of toMove) {
    const [roomiest] = [...free].sort((a, b) => b[1] - a[1]);
    if (roomiest![1] < needMb(w)) throw refuse("no_room", w);
    free.set(roomiest![0], roomiest![1] - needMb(w));
  }
}

// The leader hears of it now; the watch tick sends the roster again if this one is lost.
async function tellLeader(cluster: Cluster): Promise<void> {
  await pushLeaderRoster(cluster).catch((e) =>
    console.warn(
      `[cluster-empty] ${cluster.id}: ${e instanceof Error ? e.message : String(e)}`,
    ),
  );
}

/**
 * "Empty this server": the member takes no new work and what it holds moves to the other members, one at
 * a time, in the background. Called again on a member that stopped, it continues. Refused before anything moves.
 */
export async function emptyClusterMember(
  clusterId: string,
  serverId: string,
): Promise<Cluster> {
  const { teamId, user, cluster, server, member } = await admin(
    clusterId,
    serverId,
  );
  if (member.emptyingSince && !member.emptyingError) return cluster;
  const held = await listMemberWorkloads(serverId);
  await assertRoomElsewhere(cluster, serverId, held);
  const since = member.emptyingSince ?? nowIso();
  await getDb()
    .update(membersTable)
    .set({
      emptyingSince: since,
      emptyingError: "",
      emptyingWorkload: "",
      emptyingTotal: member.emptyingSince ? member.emptyingTotal : held.length,
      emptyingTeamId: teamId,
    })
    .where(eq(membersTable.serverId, serverId));
  await recordActivity(
    "server",
    member.emptyingSince
      ? `Continued emptying server ${server.name} of cluster ${cluster.name}`
      : held.length > 0
        ? `Started emptying server ${server.name} of cluster ${cluster.name}: ${held.length} to move`
        : `Emptied server ${server.name} of cluster ${cluster.name}: it ran nothing`,
    user.name,
    null,
    teamId,
  );
  await tellLeader(cluster);
  // A preview is no workload of the cluster, so nothing else moves it (#212).
  await movePreviewsOff(serverId).catch((e) =>
    console.warn(`[cluster-empty] ${cluster.id}: previews: ${message(e)}`),
  );
  return cluster;
}

/** "Stop emptying": the member takes work again. What is moving right now finishes its move. */
export async function stopEmptyingClusterMember(
  clusterId: string,
  serverId: string,
): Promise<Cluster> {
  const { teamId, user, cluster, server } = await admin(clusterId, serverId);
  const stopped = await getDb()
    .update(membersTable)
    .set({
      emptyingSince: null,
      emptyingError: "",
      emptyingWorkload: "",
      emptyingTotal: 0,
      emptyingTeamId: null,
    })
    .where(
      and(
        eq(membersTable.serverId, serverId),
        isNotNull(membersTable.emptyingSince),
      ),
    )
    .returning({ id: membersTable.serverId });
  if (stopped.length === 0) return cluster;
  await recordActivity(
    "server",
    `Stopped emptying server ${server.name} of cluster ${cluster.name}`,
    user.name,
    null,
    teamId,
  );
  await tellLeader(cluster);
  return cluster;
}

type Member = typeof membersTable.$inferSelect;
type Settled = "moving" | "moved" | { stopped: string };

// A deploy that went ready this recently may still be about to copy the data.
const COPY_GRACE_MS = 60_000;

async function settleApp(m: Member, id: string): Promise<Settled> {
  const [app] = await getDb()
    .select({
      name: appsTable.name,
      serverId: appsTable.serverId,
      from: appsTable.migrateFromServerId,
      deletingAt: appsTable.deletingAt,
    })
    .from(appsTable)
    .where(eq(appsTable.id, id))
    .limit(1);
  if (!app || app.deletingAt) return "moved";
  // Replicas on other servers too: a deploy re-places the ones here, and the rest keep running (#208).
  const placed = (await listWorkloadPlacements("app", [id])).get(id) ?? [];
  const on = new Set(placed.map((p) => p.serverId).filter(Boolean));
  if (on.size > 1 && on.has(m.serverId)) {
    const [dep] = await getDb()
      .select({ status: deploymentsTable.status })
      .from(deploymentsTable)
      .where(
        and(
          eq(deploymentsTable.appId, id),
          eq(deploymentsTable.environment, "production"),
        ),
      )
      .orderBy(desc(deploymentsTable.createdAt))
      .limit(1);
    if (dep?.status === "queued" || dep?.status === "building") return "moving";
    return {
      stopped: `${app.name} still runs replicas on this server. Its last deployment says why.`,
    };
  }
  if (app.serverId === m.serverId)
    return {
      stopped: `${app.name} could not be moved, so it is still on this server. Its last deployment says why.`,
    };
  if (app.from !== m.serverId) return "moved";
  const [dep] = await getDb()
    .select({
      status: deploymentsTable.status,
      readyAt: deploymentsTable.readyAt,
    })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.appId, id),
        eq(deploymentsTable.environment, "production"),
      ),
    )
    .orderBy(desc(deploymentsTable.createdAt))
    .limit(1);
  if (dep?.status === "queued" || dep?.status === "building") return "moving";
  if (dep?.status === "ready") {
    // ponytail: the copy lock is this process's own; a second Deplo instance needs a shared one.
    const copying =
      hasPendingLock(`app-lifecycle:${id}`) ||
      Date.now() - Date.parse(dep.readyAt ?? "") < COPY_GRACE_MS;
    // A restart cut the copy off: the next deploy carries the data.
    if (!copying) await redeploy(id);
    return "moving";
  }
  return {
    stopped: `${app.name} did not finish moving to its new server. Its last deployment says why.`,
  };
}

async function redeploy(appId: string): Promise<void> {
  await startDeployment(appId, {
    creator: ACTOR,
    commitMessage: "Move to a different server",
  });
}

async function settle(m: Member): Promise<Settled> {
  const [kind, id] = m.emptyingWorkload.split(":") as [string, string];
  // A database moves inside one step, so one still named here was cut off by a restart: it is moved again.
  return kind === "app" ? settleApp(m, id) : "moved";
}

async function move(
  cluster: Cluster,
  m: Member,
  w: MemberWorkload,
): Promise<void> {
  if (w.leaving || w.spread) {
    // Deployed elsewhere already and its data, or some of its replicas, are still here: a deploy carries them.
    if ((await settleApp(m, w.id)) !== "moving") await redeploy(w.id);
    return;
  }
  const from = (await getServerById(m.serverId))?.name ?? "its server";
  const to = await askLeaderToPlace(cluster, {
    kind: w.kind,
    id: w.id,
    name: w.name,
    environmentId: w.environmentId,
    limitMb: w.limitMb,
  });
  const placed = () =>
    recordPlacement({
      clusterId: cluster.id,
      kind: w.kind,
      workloadId: w.id,
      members: [to],
      epoch: cluster.leaderEpoch,
    });
  const why = `${from} is being emptied`;
  if (w.kind === "database") {
    await relocateClusterDatabase(w.id, cluster, to, why);
    await placed();
    return;
  }
  let deployed = true;
  try {
    deployed = await relocateClusterApp(w.id, cluster, to, why);
  } finally {
    const [now] = await getDb()
      .select({ serverId: appsTable.serverId })
      .from(appsTable)
      .where(eq(appsTable.id, w.id));
    if (now?.serverId === to) await placed();
  }
  // Never deployed, so the old server holds no stack and no data to wait for.
  if (!deployed)
    await getDb()
      .update(appsTable)
      .set({ migrateFromServerId: null })
      .where(eq(appsTable.id, w.id));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function halt(m: Member, cluster: Cluster, why: string): Promise<void> {
  const stopped = await getDb()
    .update(membersTable)
    .set({ emptyingError: why, emptyingWorkload: "" })
    .where(
      and(
        eq(membersTable.serverId, m.serverId),
        isNotNull(membersTable.emptyingSince),
      ),
    )
    .returning({ id: membersTable.serverId });
  // An admin stopped it meanwhile: there is nothing left to report.
  if (stopped.length === 0) return;
  const name = (await getServerById(m.serverId))?.name ?? "a server";
  await recordActivity(
    "server",
    `Stopped emptying server ${name} of cluster ${cluster.name}: ${why}`,
    ACTOR,
    null,
    m.emptyingTeamId,
  );
}

/** One thing at a time for one member. Answers whether there is more to do right away. */
async function step(serverId: string): Promise<boolean> {
  if (await instanceFrozen()) return false;
  const [m] = await getDb()
    .select()
    .from(membersTable)
    .where(eq(membersTable.serverId, serverId))
    .limit(1);
  if (!m?.emptyingSince || m.emptyingError) return false;
  const cluster = await getClusterById(m.clusterId);
  if (!cluster) return false;
  const setMoving = (workload: string) =>
    getDb()
      .update(membersTable)
      .set({ emptyingWorkload: workload })
      .where(
        and(
          eq(membersTable.serverId, serverId),
          isNotNull(membersTable.emptyingSince),
        ),
      );
  if (m.emptyingWorkload) {
    const settled = await settle(m).catch((e) => ({ stopped: message(e) }));
    if (settled === "moving") return false;
    if (settled !== "moved") {
      await halt(m, cluster, settled.stopped);
      return false;
    }
    const left = await listMemberWorkloads(serverId);
    if (left.length === 0) {
      const name = (await getServerById(serverId))?.name ?? "a server";
      await recordActivity(
        "server",
        `Emptied server ${name} of cluster ${cluster.name}`,
        ACTOR,
        null,
        m.emptyingTeamId,
      );
    }
    await setMoving("");
    return left.length > 0;
  }
  const held = await listMemberWorkloads(serverId);
  // What is half-way goes first, so a member is never left holding only somebody's data.
  const next = held.find((w) => w.leaving) ?? held[0];
  if (!next) return false;
  await setMoving(`${next.kind}:${next.id}`);
  try {
    await move(cluster, m, next);
  } catch (e) {
    await halt(m, cluster, message(e));
    return false;
  }
  return true;
}

const KEY = Symbol.for("deplo.cluster.emptying");
const g = globalThis as unknown as { [KEY]?: Map<string, Promise<void>> };
const running: Map<string, Promise<void>> = (g[KEY] ??= new Map());

async function drain(serverId: string): Promise<void> {
  try {
    while (await step(serverId));
  } catch (e) {
    console.error(`[cluster-empty] ${serverId}:`, e);
  }
}

/**
 * One background pass: every member being emptied moves on by as much as it can without waiting.
 * The state is the row, so a restart picks up where the last pass left off.
 */
export async function runEmptyingPass(): Promise<void> {
  if (await instanceFrozen()) return;
  const rows = await getDb()
    .select({ id: membersTable.serverId })
    .from(membersTable)
    .where(
      and(
        isNotNull(membersTable.emptyingSince),
        eq(membersTable.emptyingError, ""),
      ),
    );
  for (const { id } of rows)
    if (!running.has(id))
      running.set(
        id,
        drain(id).finally(() => running.delete(id)),
      );
  await Promise.all(running.values());
}
