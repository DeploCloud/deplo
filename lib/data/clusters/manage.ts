import "server-only";

import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  clusterTeams as clusterTeamsTable,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import type { Cluster } from "../../types/cluster";
import { recordActivity } from "../activity";
import { ensureClusterLeader } from "./leader";
import { getClusterById } from "./roster";

export interface ClusterSharingInput {
  allTeams: boolean;
  teamIds: string[];
}

export function cleanClusterName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A cluster needs a name");
  if (trimmed.length > 60)
    throw new Error("A cluster's name is at most 60 characters");
  return trimmed;
}

async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const taken = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable)
    .where(sql`lower(${clustersTable.name}) = ${name.toLowerCase()}`);
  if (taken.some((r) => r.id !== exceptId))
    throw new Error(`A cluster named ${name} already exists`);
}

async function assertTeamsExist(teamIds: string[]): Promise<void> {
  if (teamIds.length === 0) return;
  const known = await getDb()
    .select({ id: teamsTable.id })
    .from(teamsTable)
    .where(inArray(teamsTable.id, teamIds));
  if (known.length !== teamIds.length)
    throw new Error("One or more selected teams no longer exist.");
}

function sharingLabel(allTeams: boolean, teamIds: string[]): string {
  return allTeams
    ? "all teams"
    : `${teamIds.length} team${teamIds.length === 1 ? "" : "s"}`;
}

/** Creates a cluster and asks the machine that leads it to start its leader; the leader's trouble never undoes the cluster. */
export async function createCluster(
  name: string,
  sharing: ClusterSharingInput,
): Promise<Cluster> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const clean = cleanClusterName(name);
  const teamIds = sharing.allTeams ? [] : [...new Set(sharing.teamIds)];
  await assertNameFree(clean);
  await assertTeamsExist(teamIds);

  const id = newId("clu");
  await getDb().transaction(async (tx) => {
    await tx.insert(clustersTable).values({
      id,
      name: clean,
      allTeams: sharing.allTeams,
      createdAt: nowIso(),
    });
    if (teamIds.length > 0)
      await tx
        .insert(clusterTeamsTable)
        .values(teamIds.map((t) => ({ clusterId: id, teamId: t })));
  });

  await recordActivity(
    "server",
    `Created cluster ${clean}, shared with ${sharingLabel(sharing.allTeams, teamIds)}`,
    user.name,
    null,
    teamId,
  );
  await ensureClusterLeader(id).catch(() => undefined);
  return (await getClusterById(id))!;
}

export async function renameCluster(
  id: string,
  name: string,
): Promise<Cluster> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const clean = cleanClusterName(name);
  const cluster = await getClusterById(id);
  if (!cluster) throw new Error("Cluster not found");
  await assertNameFree(clean, id);
  const updated = await getDb()
    .update(clustersTable)
    .set({ name: clean })
    .where(eq(clustersTable.id, id))
    .returning({ id: clustersTable.id });
  if (updated.length === 0) throw new Error("Cluster not found");
  await recordActivity(
    "server",
    `Renamed cluster ${cluster.name} to ${clean}`,
    user.name,
    null,
    teamId,
  );
  return (await getClusterById(id))!;
}

export async function setClusterTeams(
  id: string,
  sharing: ClusterSharingInput,
): Promise<Cluster> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const cluster = await getClusterById(id);
  if (!cluster) throw new Error("Cluster not found");
  const teamIds = sharing.allTeams ? [] : [...new Set(sharing.teamIds)];
  await assertTeamsExist(teamIds);

  await getDb().transaction(async (tx) => {
    const locked = await tx
      .select({ id: clustersTable.id })
      .from(clustersTable)
      .where(eq(clustersTable.id, id))
      .for("update");
    if (!locked[0]) throw new Error("Cluster not found");
    await tx
      .update(clustersTable)
      .set({ allTeams: sharing.allTeams })
      .where(eq(clustersTable.id, id));
    await tx
      .delete(clusterTeamsTable)
      .where(eq(clusterTeamsTable.clusterId, id));
    if (teamIds.length > 0)
      await tx
        .insert(clusterTeamsTable)
        .values(teamIds.map((t) => ({ clusterId: id, teamId: t })));
  });

  await recordActivity(
    "server",
    `Shared cluster ${cluster.name} with ${sharingLabel(sharing.allTeams, teamIds)}`,
    user.name,
    null,
    teamId,
  );
  return (await getClusterById(id))!;
}
