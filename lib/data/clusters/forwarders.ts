import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  appBuild,
  apps as appsTable,
} from "../../db/schema/control-plane/apps";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { stackName } from "../../deploy/deploy-key";
import {
  isForwardedApp,
  planNameForwarding,
  type ForwardedWorkload,
  type MemberForwarding,
} from "../../deploy/name-forwarders";
import { appNetwork } from "../../deploy/network";
import { setClusterForwarders } from "../../infra/agent-client/cluster-host";
import { AgentClusterForwardersUnsupportedError } from "../../infra/agent-client/errors";
import { instanceFrozen } from "../deplo-move/freeze";
import { listWorkloadPlacements } from "./placement";
import { fingerprintOf } from "./relay";
import { clusterMemberServerIds } from "./roster";

// The control plane renders which names go on which member; each agent only runs its own table (#200).

async function workloadsOf(clusterId: string): Promise<ForwardedWorkload[]> {
  const db = getDb();
  const apps = await db
    .select({
      id: appsTable.id,
      slug: appsTable.slug,
      teamId: appsTable.teamId,
      environmentId: appsTable.environmentId,
      serverId: appsTable.serverId,
      clusterId: appsTable.clusterId,
      source: appsTable.source,
      compose: appsTable.compose,
      dockerImage: appsTable.dockerImage,
      repoUrl: appsTable.repoUrl,
      port: appBuild.port,
    })
    .from(appsTable)
    .innerJoin(appBuild, eq(appBuild.appId, appsTable.id))
    .where(eq(appsTable.clusterId, clusterId));
  const dbs = await db
    .select({
      id: databasesTable.id,
      host: databasesTable.host,
      port: databasesTable.port,
      teamId: databasesTable.teamId,
      environmentId: databasesTable.environmentId,
      serverId: databasesTable.serverId,
    })
    .from(databasesTable)
    .where(eq(databasesTable.clusterId, clusterId));
  const [appPlacements, dbPlacements] = await Promise.all([
    listWorkloadPlacements(
      "app",
      apps.map((a) => a.id),
    ),
    listWorkloadPlacements(
      "database",
      dbs.map((d) => d.id),
    ),
  ]);
  const membersOf = (
    placed: { serverId: string | null }[] | undefined,
    fallback: string | null,
  ): string[] => {
    const ids = (placed ?? [])
      .map((p) => p.serverId)
      .filter((s): s is string => Boolean(s));
    return ids.length > 0 ? ids : fallback ? [fallback] : [];
  };
  const out: ForwardedWorkload[] = [];
  for (const a of apps) {
    if (
      !isForwardedApp({
        clusterId: a.clusterId,
        source: a.source,
        compose: a.compose,
        dockerImage: a.dockerImage,
        repo: a.repoUrl,
      })
    )
      continue;
    out.push({
      kind: "app",
      id: a.id,
      network: appNetwork(a),
      name: stackName(a.slug),
      port: a.port,
      members: membersOf(appPlacements.get(a.id), a.serverId),
    });
  }
  for (const d of dbs)
    out.push({
      kind: "database",
      id: d.id,
      network: appNetwork(d),
      name: d.host,
      port: d.port,
      members: membersOf(dbPlacements.get(d.id), d.serverId),
    });
  return out;
}

/** What every member of the cluster runs: the Environment's names, and no one else's. */
export async function planClusterForwarding(
  clusterId: string,
): Promise<Map<string, MemberForwarding>> {
  const fingerprints = new Map<string, string>();
  for (const id of await clusterMemberServerIds(clusterId)) {
    const fp = await fingerprintOf(id);
    if (fp) fingerprints.set(id, fp);
  }
  const plan = planNameForwarding({
    workloads: await workloadsOf(clusterId),
    fingerprints,
  });
  // Only servers of this cluster ever get a table, whatever a stale placement names.
  for (const id of [...plan.keys()]) if (!fingerprints.has(id)) plan.delete(id);
  return plan;
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e))
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

/** Hands each member of the cluster its table; one that cannot be reached is named in the log and left for the next sweep. */
export async function syncNameForwarders(clusterId: string): Promise<void> {
  if (await instanceFrozen()) return;
  const members = await clusterMemberServerIds(clusterId);
  const plan = await planClusterForwarding(clusterId);
  const roster: { serverId: string; fingerprint: string }[] = [];
  for (const serverId of members) {
    const fingerprint = await fingerprintOf(serverId);
    if (fingerprint) roster.push({ serverId, fingerprint });
  }
  for (const serverId of members) {
    if (await instanceFrozen()) return;
    const mine = plan.get(serverId);
    try {
      await setClusterForwarders(serverId, {
        clusterId,
        members: roster,
        hold: mine?.hold ?? [],
        serve: mine?.serve ?? [],
      });
    } catch (e) {
      // A member with nothing to run and an agent too old to take the table is not a problem.
      if (!mine && e instanceof AgentClusterForwardersUnsupportedError)
        continue;
      console.warn(
        `[cluster-forwarders] ${clusterId} -> ${serverId}: ${message(e)}`,
      );
    }
  }
}

/** After a deploy or a placement change: off the caller's lane, and it never throws. */
export function syncNameForwardersSoon(clusterId: string): void {
  void syncNameForwarders(clusterId).catch((e) =>
    console.warn(`[cluster-forwarders] ${clusterId}: ${message(e)}`),
  );
}

/** The sweep's job: a member that joined, left or came back gets its table. */
export async function reconcileNameForwarders(): Promise<void> {
  const rows = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable);
  for (const c of rows) {
    if (await instanceFrozen()) return;
    await syncNameForwarders(c.id);
  }
}

/** The deploy's tail for a cluster App: its name may now be on a member that held none. */
export function syncNameForwardersAfterDeploy(depId: string): void {
  void (async () => {
    const dep = (
      await getDb()
        .select({ clusterId: appsTable.clusterId })
        .from(deploymentsTable)
        .innerJoin(appsTable, eq(appsTable.id, deploymentsTable.appId))
        .where(eq(deploymentsTable.id, depId))
        .limit(1)
    )[0];
    if (dep?.clusterId) await syncNameForwarders(dep.clusterId);
  })().catch((e) =>
    console.warn(`[cluster-forwarders] ${depId}: ${message(e)}`),
  );
}
