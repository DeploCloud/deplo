import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterImageCopies,
  workloadPlacements,
} from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { nowIso } from "../../ids";
import { callClusterLeader } from "../../infra/agent-client/cluster-host";
import type { Cluster } from "../../types/cluster";
import { instanceFrozen } from "../deplo-move/freeze";
import { syncNameForwardersSoon } from "./forwarders";
import { leaderHost } from "./host";
import { clusterMemberServerIds } from "./roster";

export type WorkloadKind = "app" | "database";

/** What the leader needs to pick a member; the control plane never picks one itself. */
export interface PlacementRequest {
  kind: WorkloadKind;
  id: string;
  name: string;
  environmentId: string | null;
  /** The App's memory limit in MB; 0 asks for its 24-hour peak, then the 256 MB floor. */
  limitMb: number;
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
  refusal?: PlacementRefusal;
} {
  try {
    const a = JSON.parse(new TextDecoder().decode(raw)) as {
      member?: unknown;
      refusal?: Partial<PlacementRefusal> | null;
    };
    if (typeof a.member === "string" && a.member) return { member: a.member };
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

/**
 * Asks the cluster's leader (through the agent that supervises it) which member runs the workload.
 * A refusal throws PlacementRefusedError with the sentence; nothing is written or stopped.
 */
export async function askLeaderToPlace(
  cluster: Cluster,
  req: PlacementRequest,
): Promise<string> {
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
          },
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
  if (!answer.member || !members.includes(answer.member))
    throw new PlacementUnavailableError(
      `Cluster ${cluster.name}'s leader named a server that is not in it.`,
    );
  return answer.member;
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
