import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { backupDestination as destinationTable } from "../../db/schema/control-plane/backups";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { getCurrentUser } from "../../auth/current-user";
import { requireInstanceAdmin } from "../../membership";
import { relocateAppOffServer } from "../apps/source";
import { relocateDatabaseOffServer } from "../databases/server-move";
import { dropDestination, removalImpactIn } from "../destinations/removal";
import { listClusterLeaderChoices } from "../clusters/leader-move";
import { clusterMemberServerIdSet } from "../clusters/members";
import { canHostWorkloads, getServerById, listServersForTeam } from "./roster";

// https://deplo.build/docs/operations/remove-a-server-or-uninstall

export type RemovalTarget = { id: string; name: string };

export type RemovalItem = {
  id: string;
  name: string;
  /** The team it belongs to; empty for a cluster. */
  teamName: string;
  /** Where it can go from here; empty when nowhere. */
  moveTo: RemovalTarget[];
  /** Why it cannot be moved from here right now, e.g. it is being deleted; empty when it can. */
  note: string;
};

export type RemovalDestination = {
  id: string;
  name: string;
  teamName: string;
  schedules: number;
  artifacts: number;
};

export type ServerRemovalBlockers = {
  apps: RemovalItem[];
  databases: RemovalItem[];
  clusters: RemovalItem[];
  destinations: RemovalDestination[];
  /** Apps still copying their data off this server: removing it now leaves that data behind. */
  copying: string[];
  /** False while the server does not answer: nothing kept on it can be deleted then. */
  online: boolean;
};

/** What keeps a server from being removed. Ungated: the refusal and the dialog read the same rows. */
export async function blockingRows(id: string) {
  const db = getDb();
  const [apps, databases, clusters, destinations] = await Promise.all([
    db
      .select({
        id: appsTable.id,
        slug: appsTable.slug,
        name: appsTable.name,
        teamId: appsTable.teamId,
        teamName: teamsTable.name,
        deletingAt: appsTable.deletingAt,
      })
      .from(appsTable)
      .leftJoin(teamsTable, eq(teamsTable.id, appsTable.teamId))
      .where(eq(appsTable.serverId, id)),
    db
      .select({
        id: databasesTable.id,
        name: databasesTable.name,
        teamId: databasesTable.teamId,
        teamName: teamsTable.name,
        status: databasesTable.status,
      })
      .from(databasesTable)
      .leftJoin(teamsTable, eq(teamsTable.id, databasesTable.teamId))
      .where(eq(databasesTable.serverId, id)),
    db
      .select({ id: clustersTable.id, name: clustersTable.name })
      .from(clustersTable)
      .where(eq(clustersTable.leaderServerId, id)),
    db
      .select({
        id: destinationTable.id,
        name: destinationTable.name,
        teamId: destinationTable.teamId,
        teamName: teamsTable.name,
      })
      .from(destinationTable)
      .leftJoin(teamsTable, eq(teamsTable.id, destinationTable.teamId))
      .where(eq(destinationTable.serverId, id)),
  ]);
  return { apps, databases, clusters, destinations };
}

// The servers a team's workload can move to: granted to the team, online, hosting workloads, outside any cluster.
async function targetsFor(serverId: string) {
  const inCluster = await clusterMemberServerIdSet();
  const byTeam = new Map<string, Promise<RemovalTarget[]>>();
  return (teamId: string) => {
    if (!byTeam.has(teamId))
      byTeam.set(
        teamId,
        listServersForTeam(teamId).then((servers) =>
          servers
            .filter(
              (s) =>
                s.id !== serverId &&
                canHostWorkloads(s) &&
                Boolean(s.agent?.certFingerprint) &&
                s.status !== "offline" &&
                !inCluster.has(s.id),
            )
            .map((s) => ({ id: s.id, name: s.name })),
        ),
      );
    return byTeam.get(teamId)!;
  };
}

export async function serverRemovalBlockers(
  serverId: string,
): Promise<ServerRemovalBlockers> {
  await requireInstanceAdmin();
  const server = await getServerById(serverId);
  if (!server) throw new Error("Server not found");
  const rows = await blockingRows(serverId);
  const targets = await targetsFor(serverId);
  const copying = await getDb()
    .select({ name: appsTable.name })
    .from(appsTable)
    .where(
      and(
        eq(appsTable.migrateFromServerId, serverId),
        isNull(appsTable.deletingAt),
      ),
    );
  return {
    apps: await Promise.all(
      rows.apps.map(async (a) => ({
        id: a.id,
        name: a.name,
        teamName: a.teamName ?? "",
        moveTo: a.deletingAt ? [] : await targets(a.teamId),
        note: a.deletingAt ? "Being deleted" : "",
      })),
    ),
    databases: await Promise.all(
      rows.databases.map(async (d) => ({
        id: d.id,
        name: d.name,
        teamName: d.teamName ?? "",
        moveTo: d.status === "provisioning" ? [] : await targets(d.teamId),
        note: d.status === "provisioning" ? "Still being created" : "",
      })),
    ),
    clusters: await Promise.all(
      rows.clusters.map(async (c) => ({
        id: c.id,
        name: c.name,
        teamName: "",
        moveTo: (await listClusterLeaderChoices(c.id))
          .filter((o) => !o.blocked && !o.current && o.serverId !== serverId)
          .map((o) => ({ id: o.serverId, name: o.serverName })),
        note: "",
      })),
    ),
    destinations: await Promise.all(
      rows.destinations.map(async (d) => {
        const impact = await removalImpactIn(d.teamId, d.id);
        return {
          id: d.id,
          name: d.name,
          teamName: d.teamName ?? "",
          schedules: impact.schedules,
          artifacts: impact.artifacts,
        };
      }),
    ),
    copying: copying.map((a) => a.name),
    online: server.status !== "offline",
  };
}

async function adminOn(serverId: string) {
  await requireInstanceAdmin();
  const server = await getServerById(serverId);
  if (!server) throw new Error("Server not found");
  const user = (await getCurrentUser())!;
  return { server, user, why: `${server.name} is being removed` };
}

/** Moves one App or database off a server being removed, for whichever team owns it. */
export async function moveOffServer(
  serverId: string,
  kind: "app" | "database",
  id: string,
  toServerId: string,
): Promise<void> {
  const { user, why } = await adminOn(serverId);
  const rows = await blockingRows(serverId);
  const on = (kind === "app" ? rows.apps : rows.databases).some(
    (w) => w.id === id,
  );
  if (!on) throw new Error(`That ${kind} is not on this server any more.`);
  if (kind === "app") await relocateAppOffServer(id, toServerId, user, why);
  else await relocateDatabaseOffServer(id, toServerId, user.name, why);
}

/** Removes a backup destination kept on a server being removed, for whichever team owns it. */
export async function removeDestinationOffServer(
  serverId: string,
  id: string,
  deleteArtifacts: boolean,
): Promise<void> {
  const { user } = await adminOn(serverId);
  const d = (await blockingRows(serverId)).destinations.find(
    (x) => x.id === id,
  );
  if (!d) throw new Error("That destination is not on this server any more.");
  await dropDestination(d.teamId, id, user.name, { deleteArtifacts });
}
