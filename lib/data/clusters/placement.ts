import "server-only";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { type DbTx, getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterImageCopies,
  workloadPlacements,
} from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { deployments } from "../../db/schema/control-plane/deployments";
import { nowIso } from "../../ids";
import { callClusterLeader } from "../../infra/agent-client/cluster-host";
import { requireActiveTeamId } from "../../membership";
import type { Cluster } from "../../types/cluster";
import { instanceFrozen } from "../deplo-move/freeze";
import { clusterMemberFacts } from "./facts";
import { syncNameForwardersSoon } from "./forwarders";
import { leaderHost } from "./host";
import { memberIsEmptying } from "./member-workloads";
import { clusterMemberServerIds, getCluster } from "./roster";

export type WorkloadKind = "app" | "database";

/** What the leader needs to pick a member; the control plane never picks one itself. */
export interface PlacementRequest {
  kind: WorkloadKind;
  id: string;
  name: string;
  environmentId: string | null;
  /** The App's memory limit in MB; 0 asks for its 24-hour peak, then the 256 MB floor. */
  limitMb: number;
  /** A built release the members must already hold; empty for a first placement or a pulled image. */
  imageRef?: string;
  /** The architectures the image runs on; empty means any. */
  archs?: string[];
}

export type PlacementRefusalReason =
  "no_member_online" | "no_architecture" | "no_image" | "no_room";

export interface PlacementRefusal {
  reason: PlacementRefusalReason;
  neededMb: number;
  cluster: string;
  workload: string;
}

/** The leader said no. The message is the sentence the user reads. */
export class PlacementRefusedError extends Error {
  constructor(
    readonly refusal: PlacementRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** The leader could not be asked or gave an answer that cannot be used. */
export class PlacementUnavailableError extends Error {}

const REASON_REFUSALS = new Set<string>([
  "no_member_online",
  "no_architecture",
  "no_image",
  "no_room",
]);

/** The fixed set of sentences a refusal becomes. */
export function refusalSentence(
  r: PlacementRefusal,
  names: { cluster: string; workload: string },
): string {
  const { cluster, workload } = names;
  switch (r.reason) {
    case "no_room":
      return `No server in cluster ${cluster} has ${r.neededMb} MB free. Add a server to it or lower ${workload}'s memory.`;
    case "no_member_online":
      return `No server in cluster ${cluster} is online and ready right now, so ${workload} has nowhere to run. Bring a server back or add one.`;
    case "no_architecture":
      return `No server in cluster ${cluster} has the kind of processor ${workload} was built for. Add a server that does.`;
    case "no_image":
      return `No server in cluster ${cluster} has ${workload}'s image yet. Try again in a minute.`;
  }
}

function parseAnswer(raw: Uint8Array): {
  member?: string;
  members?: (string | null)[];
  refusal?: PlacementRefusal;
} {
  try {
    const a = JSON.parse(new TextDecoder().decode(raw)) as {
      member?: unknown;
      members?: unknown;
      refusal?: Partial<PlacementRefusal> | null;
    };
    if (typeof a.member === "string" && a.member) return { member: a.member };
    if (Array.isArray(a.members) && a.members.length > 0)
      return {
        members: a.members.map((m) => (typeof m === "string" && m ? m : null)),
      };
    const r = a.refusal;
    if (r && REASON_REFUSALS.has(String(r.reason)))
      return {
        refusal: {
          reason: r.reason as PlacementRefusalReason,
          neededMb: Number(r.neededMb) || 0,
          cluster: String(r.cluster ?? ""),
          workload: String(r.workload ?? ""),
        },
      };
  } catch {
    // falls through to the same error as an empty answer
  }
  throw new PlacementUnavailableError(
    "The cluster's leader gave an answer Deplo could not read.",
  );
}

async function askLeader(
  cluster: Cluster,
  req: PlacementRequest,
  many?: { replicas: number; current: (string | null)[] },
): Promise<{ member?: string; members?: (string | null)[] }> {
  const host = await leaderHost(cluster);
  if (!host)
    throw new PlacementUnavailableError(
      "The cluster's leader is not running yet, so nothing can be placed on it.",
    );
  let raw: Uint8Array;
  try {
    raw = await callClusterLeader(
      host.id,
      "placement.place",
      new TextEncoder().encode(
        JSON.stringify({
          cluster: cluster.id,
          workload: {
            kind: req.kind,
            id: req.id,
            name: req.name,
            environment: req.environmentId ?? "",
            limitMb: req.limitMb,
            image: req.imageRef ?? "",
            archs: req.archs ?? [],
          },
          members: await clusterMemberFacts(cluster.id),
          ...(many
            ? {
                replicas: many.replicas,
                current: many.current.map((m) => m ?? ""),
              }
            : {}),
        }),
      ),
    );
  } catch (e) {
    throw new PlacementUnavailableError(
      `Cluster ${cluster.name}'s leader did not answer, so nothing was placed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const answer = parseAnswer(raw);
  if (answer.refusal)
    throw new PlacementRefusedError(
      answer.refusal,
      refusalSentence(answer.refusal, {
        cluster: cluster.name,
        workload: req.name,
      }),
    );
  const members = await clusterMemberServerIds(cluster.id);
  const named = answer.members ?? [answer.member ?? null];
  if (named.every((m) => !m) || named.some((m) => m && !members.includes(m)))
    throw new PlacementUnavailableError(
      `Cluster ${cluster.name}'s leader named a server that is not in it.`,
    );
  // The leader may not have heard yet; nothing new lands on a member that is being emptied.
  for (const m of new Set(named))
    if (m && (await memberIsEmptying(m)))
      throw new PlacementUnavailableError(
        `Cluster ${cluster.name}'s leader named a server that is being emptied. Try again in a moment.`,
      );
  return answer;
}

/**
 * Asks the cluster's leader (through the agent that supervises it) which member runs the workload.
 * A refusal throws PlacementRefusedError with the sentence; nothing is written or stopped.
 */
export async function askLeaderToPlace(
  cluster: Cluster,
  req: PlacementRequest,
): Promise<string> {
  const { member } = await askLeader(cluster, req);
  if (!member)
    throw new PlacementUnavailableError(
      `Cluster ${cluster.name}'s leader named a server that is not in it.`,
    );
  return member;
}

/**
 * Asks the leader where each of an App's replicas runs, spread across members. `current` is where each one
 * runs now; null in the answer is a replica the leader keeps waiting for room.
 */
export async function askLeaderToSpread(
  cluster: Cluster,
  req: PlacementRequest,
  replicas: number,
  current: (string | null)[],
): Promise<(string | null)[]> {
  const { members } = await askLeader(cluster, req, { replicas, current });
  if (members?.length !== replicas)
    throw new PlacementUnavailableError(
      "The cluster's leader gave an answer Deplo could not read.",
    );
  return members;
}

export interface PlacementReport {
  clusterId: string;
  kind: WorkloadKind;
  workloadId: string;
  /** One entry per replica in placement order; null is waiting for room. */
  members: (string | null)[];
  epoch: number;
}

/**
 * The only writer of `workload_placements` and of a cluster workload's `server_id`: mirrors what the
 * leader says. `server_id` becomes the first member in placement order, and is left alone while waiting.
 */
export async function recordPlacement(r: PlacementReport): Promise<boolean> {
  const members = new Set(await clusterMemberServerIds(r.clusterId));
  for (const m of r.members)
    if (m && !members.has(m))
      throw new Error("A placement named a server that is not in the cluster.");
  const table = r.kind === "app" ? appsTable : databasesTable;
  return getDb().transaction(async (tx) => {
    const owned = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, r.workloadId), eq(table.clusterId, r.clusterId)))
      .limit(1);
    if (owned.length === 0) return false;
    const now = nowIso();
    await tx
      .delete(workloadPlacements)
      .where(
        and(
          eq(workloadPlacements.kind, r.kind),
          eq(workloadPlacements.workloadId, r.workloadId),
        ),
      );
    if (r.members.length > 0)
      await tx.insert(workloadPlacements).values(
        r.members.map((m, replica) => ({
          kind: r.kind,
          workloadId: r.workloadId,
          replica,
          memberServerId: m,
          epoch: r.epoch,
          updatedAt: now,
        })),
      );
    const first = r.members.find((m): m is string => Boolean(m));
    if (first)
      await tx
        .update(table)
        .set({ serverId: first })
        .where(eq(table.id, r.workloadId));
    return true;
  });
}

/**
 * A server joining a cluster brings its workloads where they run: one row per replica, on that server.
 * Runs inside the join's transaction, so a member never exists without them.
 */
export async function recordJoinedPlacements(
  tx: DbTx,
  serverId: string,
  epoch: number,
  joined: { kind: WorkloadKind; id: string; replicas: number }[],
): Promise<void> {
  if (joined.length === 0) return;
  const now = nowIso();
  await tx
    .insert(workloadPlacements)
    .values(
      joined.flatMap((w) =>
        Array.from({ length: Math.max(w.replicas, 1) }, (_, replica) => ({
          kind: w.kind,
          workloadId: w.id,
          replica,
          memberServerId: serverId,
          epoch,
          updatedAt: now,
        })),
      ),
    )
    .onConflictDoNothing();
}

/** A leader's report arriving in the background: ignored while a Deplo move freezes this instance. */
export async function applyLeaderReport(r: PlacementReport): Promise<boolean> {
  if (await instanceFrozen()) return false;
  const recorded = await recordPlacement(r);
  // A member that now runs one of the Environment's workloads needs its names (#200).
  if (recorded) syncNameForwardersSoon(r.clusterId);
  return recorded;
}

/** Drops the mirror when a workload leaves its cluster or is deleted. */
export async function clearPlacement(
  kind: WorkloadKind,
  workloadId: string,
): Promise<void> {
  if (kind === "app")
    await getDb()
      .delete(clusterImageCopies)
      .where(eq(clusterImageCopies.appId, workloadId));
  await getDb()
    .delete(workloadPlacements)
    .where(
      and(
        eq(workloadPlacements.kind, kind),
        eq(workloadPlacements.workloadId, workloadId),
      ),
    );
}

export interface WorkloadPlacement {
  replica: number;
  serverId: string | null;
  epoch: number;
}

/** Where each replica of a workload runs now, in placement order; the readers that need every member. */
export async function listWorkloadPlacements(
  kind: WorkloadKind,
  workloadIds: string[],
): Promise<Map<string, WorkloadPlacement[]>> {
  const out = new Map<string, WorkloadPlacement[]>();
  if (workloadIds.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(workloadPlacements)
    .where(
      and(
        eq(workloadPlacements.kind, kind),
        inArray(workloadPlacements.workloadId, workloadIds),
      ),
    )
    .orderBy(asc(workloadPlacements.replica));
  for (const r of rows) {
    const list = out.get(r.workloadId) ?? [];
    list.push({
      replica: r.replica,
      serverId: r.memberServerId,
      epoch: r.epoch,
    });
    out.set(r.workloadId, list);
  }
  return out;
}

/** Every server that runs replicas of an App, the one it "runs on now" first: stop, start, re-apply and delete reach them all. */
export async function listAppMembers(app: {
  id: string;
  clusterId?: string | null;
  serverId: string;
}): Promise<string[]> {
  if (!app.clusterId) return [app.serverId];
  const placed = (await listWorkloadPlacements("app", [app.id])).get(app.id);
  return [
    ...new Set(
      [app.serverId, ...(placed ?? []).map((p) => p.serverId)].filter(
        (s): s is string => Boolean(s),
      ),
    ),
  ];
}

/**
 * The servers that hold an App's logs: the one it runs on now, every member a replica is placed on, and
 * the member its release was deployed on when a failover has since moved it off.
 */
export async function listAppLogMembers(app: {
  id: string;
  clusterId?: string | null;
  serverId: string;
}): Promise<string[]> {
  if (!app.clusterId) return [app.serverId];
  const [placed, [release], cluster] = await Promise.all([
    listWorkloadPlacements("app", [app.id]),
    getDb()
      .select({ serverId: deployments.serverId })
      .from(deployments)
      .where(
        and(
          eq(deployments.appId, app.id),
          eq(deployments.status, "ready"),
          eq(deployments.environment, "production"),
        ),
      )
      .orderBy(desc(deployments.seq))
      .limit(1),
    clusterMemberServerIds(app.clusterId),
  ]);
  const members = (placed.get(app.id) ?? []).map((p) => p.serverId);
  const left = release?.serverId;
  return [
    ...new Set(
      [
        app.serverId,
        ...members,
        left && cluster.includes(left) ? left : null,
      ].filter((s): s is string => Boolean(s)),
    ),
  ];
}

async function replicasRunning(
  appId: string,
): Promise<{ running: number; total: number }> {
  const rows = await getDb()
    .select({ member: workloadPlacements.memberServerId })
    .from(workloadPlacements)
    .where(
      and(
        eq(workloadPlacements.kind, "app"),
        eq(workloadPlacements.workloadId, appId),
      ),
    );
  return {
    running: rows.filter((r) => r.member !== null).length,
    total: rows.length,
  };
}

/**
 * "Waiting for room in eu" while the leader has nowhere to run an App, or "2 of 3 replicas running · waiting
 * for room" while only some of them found a server; null once all run, or for an App on one server.
 */
export async function waitingForRoomNote(
  appId: string,
  clusterName: string | null,
): Promise<string | null> {
  if (!clusterName) return null;
  const { running, total } = await replicasRunning(appId);
  if (running === total) return null;
  return running > 0
    ? `${running} of ${total} replicas running · waiting for room`
    : `Waiting for room in ${clusterName}`;
}

/** The replica count line for the Replicas setting; null unless only some of an App's replicas run. */
export async function appReplicasWaiting(app: {
  id: string;
  clusterId?: string | null;
}): Promise<string | null> {
  if (!app.clusterId) return null;
  const { running, total } = await replicasRunning(app.id);
  return running > 0 && running < total
    ? `${running} of ${total} replicas running · waiting for room`
    : null;
}

/** The same note for an App the caller already read under its own gates. */
export async function appWaitingNote(app: {
  id: string;
  clusterId?: string | null;
}): Promise<string | null> {
  if (!app.clusterId) return null;
  // A cluster the team can no longer see is not named to it.
  const cluster = await getCluster(app.clusterId);
  return waitingForRoomNote(app.id, cluster?.name ?? null);
}

/**
 * The active team's Apps on this cluster that found no room after a server stopped, by name. The leader tries
 * them again every 30 seconds, so the list clears itself.
 */
export async function listClusterWaiting(clusterId: string): Promise<string[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .selectDistinct({ name: appsTable.name })
    .from(workloadPlacements)
    .innerJoin(appsTable, eq(appsTable.id, workloadPlacements.workloadId))
    .where(
      and(
        eq(workloadPlacements.kind, "app"),
        isNull(workloadPlacements.memberServerId),
        eq(appsTable.clusterId, clusterId),
        eq(appsTable.teamId, teamId),
      ),
    )
    .orderBy(asc(appsTable.name));
  return rows.map((r) => r.name);
}
