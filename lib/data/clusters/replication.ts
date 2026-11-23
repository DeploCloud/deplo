import "server-only";

import { and, eq, inArray, notInArray, or } from "drizzle-orm";
import { appDisk, copiesActivity } from "../../apps/failover-copy";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterAppReplicas,
  clusterMembers as membersTable,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { nowIso } from "../../ids";
import { CLUSTER_REPLICAS_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { connectAgent } from "../../infra/agent-client/connect";
import type {
  ClusterReplicaReport,
  ClusterReplicaTable,
} from "../../infra/agent-client/connection";
import { messageOf } from "../../utils";
import { recordActivity } from "../activity";
import { loadAppGraph } from "../app-graph-load";
import { standbyForCluster } from "../databases/standby";
import { instanceFrozen } from "../deplo-move/freeze";
import { getServerById } from "../servers/roster";
import { refreshAppBundle, restoreDescriptor } from "./app-restore";
import { storedBundle } from "./bundles";
import { fingerprintOf } from "./relay";
import { promotable, replicaRows } from "./replica-state";
import { clusterOutOfReach } from "./reach";
import { getClusterById } from "./roster";

// Replication (ADR-0046): each member's server agent is handed the cluster's replicated Apps. The one that runs an
// App sends every change of its data, as it happens, to the others over the cluster relay; each keeps a copy a
// failover puts in place. Deplo only hands out the table and reads back how each copy stands.
// https://deplo.build/docs/operations/clusters/replication

export const AGENT_TOO_OLD =
  "This server's agent is too old to keep a copy. Deplo updates it on its own.";

const quietly = (what: string) => (e: unknown) =>
  console.warn(`[replication] ${what}: ${messageOf(e)}`);

/** What every member of a cluster is handed: its replicated Apps, under the names their stacks use. */
export async function replicaTable(
  clusterId: string,
): Promise<ClusterReplicaTable> {
  const db = getDb();
  const cluster = await getClusterById(clusterId);
  const memberIds = (
    await db
      .select({ id: membersTable.serverId })
      .from(membersTable)
      .where(eq(membersTable.clusterId, clusterId))
  ).map((m) => m.id);
  const members: ClusterReplicaTable["members"] = [];
  for (const id of memberIds) {
    const fingerprint = await fingerprintOf(id);
    if (fingerprint) members.push({ serverId: id, fingerprint });
  }
  const entries: ClusterReplicaTable["entries"] = [];
  if (cluster?.replicationEnabled) {
    const apps = await db
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(eq(appsTable.clusterId, clusterId));
    for (const a of apps) {
      const app = await loadAppGraph(a.id);
      if (!app || appDisk(app) !== "volume") continue;
      // Only what was deployed on the cluster has a stack whose volume names are known.
      const held = await storedBundle(app.id);
      if (!held) continue;
      const d = restoreDescriptor(app, held.stack);
      if (d.volumeNames.length === 0 && !d.includeFiles) continue;
      entries.push({
        appId: app.id,
        slug: app.slug,
        volumeNames: d.volumeNames,
        includeFiles: d.includeFiles,
      });
    }
  }
  return { clusterId, members, entries };
}

// What each member was last handed, so a table that did not change is not sent again.
const handed = new Map<string, string>();

/** Hands every member the table and reads back its copies; a member that cannot take it is noted, the rest go on. */
export async function pushReplicaTables(
  clusterId: string,
  force = false,
): Promise<Map<string, ClusterReplicaReport[] | string>> {
  const table = await replicaTable(clusterId);
  const sum = JSON.stringify(table);
  const out = new Map<string, ClusterReplicaReport[] | string>();
  for (const m of table.members) {
    const key = `${clusterId}|${m.serverId}`;
    try {
      const conn = await connectAgent(m.serverId);
      try {
        const hello = await conn.hello();
        if (!hello.capabilities?.includes(CLUSTER_REPLICAS_CAPABILITY)) {
          out.set(m.serverId, AGENT_TOO_OLD);
          continue;
        }
        if (force || handed.get(key) !== sum) {
          await conn.setClusterReplicas(table);
          handed.set(key, sum);
        }
        out.set(m.serverId, await conn.clusterReplicaStatus());
      } finally {
        conn.close();
      }
    } catch (e) {
      handed.delete(key);
      out.set(m.serverId, `This server did not answer: ${messageOf(e)}`);
    }
  }
  return out;
}

const appsOf = (clusterId: string) =>
  getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(eq(appsTable.clusterId, clusterId));

/**
 * Stores how each copy stands, says so on the App's Activity once its first copy is whole, and keeps its failover
 * bundle in step: a copy a failover can put in place moves the App, none makes it wait.
 */
async function recordReports(
  clusterId: string,
  reports: Map<string, ClusterReplicaReport[] | string>,
): Promise<void> {
  const db = getDb();
  const table = await replicaTable(clusterId);
  const ids = table.entries.map((e) => e.appId);
  const before = await replicaRows(ids);
  const at = nowIso();
  for (const e of table.entries)
    for (const [serverId, got] of reports) {
      const r =
        typeof got === "string"
          ? null
          : (got.find((x) => x.appId === e.appId) ?? null);
      const row = {
        appId: e.appId,
        serverId,
        role: r?.role ?? "idle",
        connected: r?.connected ?? false,
        synced: r?.synced ?? false,
        appliedAt: r?.appliedAt || null,
        bytes: r?.bytes ?? 0,
        error: typeof got === "string" ? got : (r?.error ?? ""),
        checkedAt: at,
      };
      await db
        .insert(clusterAppReplicas)
        .values(row)
        .onConflictDoUpdate({
          target: [clusterAppReplicas.appId, clusterAppReplicas.serverId],
          set: row,
        });
    }
  // Apps no longer replicated, and servers that left the cluster, keep no status.
  const servers = [...reports.keys()];
  const stale = [
    ids.length ? notInArray(clusterAppReplicas.appId, ids) : undefined,
    servers.length
      ? notInArray(clusterAppReplicas.serverId, servers)
      : undefined,
  ].filter((c) => c !== undefined);
  await db
    .delete(clusterAppReplicas)
    .where(
      and(
        inArray(clusterAppReplicas.appId, appsOf(clusterId)),
        ids.length === 0 || stale.length === 0 ? undefined : or(...stale),
      ),
    );
  const after = await replicaRows(ids);
  for (const e of table.entries) {
    const app = await loadAppGraph(e.appId);
    if (!app) continue;
    const was = promotable(before, app);
    const now = promotable(after, app);
    if (was === now) continue;
    await refreshAppBundle(app.id).catch(quietly(app.slug));
    // The App's page and its Activity say the same line.
    const { copyRows } = await import("../apps/failover");
    const rows = await copyRows(app, [...reports.keys()], after);
    const server = (await getServerById(app.serverId))?.name ?? "its server";
    await recordActivity(
      "app",
      copiesActivity(app.name, server, rows, now),
      "Deplo",
      app.id,
      app.teamId,
    );
  }
}

/** One cluster: the table out, the status back, the bundles in step, and the databases' standby copies. */
export async function replicateCluster(
  clusterId: string,
  force = false,
): Promise<void> {
  if (await instanceFrozen()) return;
  // Nobody answers: how each copy stood when Deplo last heard is kept, never a guess. Asked again after the
  // servers were, since a pass that began just before the silence spends its timeouts on it.
  if (await clusterOutOfReach(clusterId)) return;
  const reports = await pushReplicaTables(clusterId, force);
  if (await clusterOutOfReach(clusterId)) return;
  await recordReports(clusterId, reports);
  await standbyForCluster(clusterId);
}

let passing = false;

/** The watch's job: every cluster that replicates, or did until now and still has copies or standbys to remove. */
export async function runReplicationPass(): Promise<void> {
  if (passing || (await instanceFrozen())) return;
  passing = true;
  try {
    const db = getDb();
    const on = await db
      .select({ id: clustersTable.id })
      .from(clustersTable)
      .where(eq(clustersTable.replicationEnabled, true));
    const left = await db
      .selectDistinct({ id: appsTable.clusterId })
      .from(clusterAppReplicas)
      .innerJoin(appsTable, eq(appsTable.id, clusterAppReplicas.appId));
    const standbys = await db
      .selectDistinct({ id: databasesTable.clusterId })
      .from(databasesTable)
      .where(eq(databasesTable.standbyFromCluster, true));
    const ids = new Set(
      [...on, ...left, ...standbys]
        .map((r) => r.id)
        .filter((id): id is string => Boolean(id)),
    );
    for (const id of ids) await replicateCluster(id).catch(quietly(id));
  } finally {
    passing = false;
  }
}

const now = new Map<string, Promise<void>>();

/** An App's first copy starts the moment it runs on the cluster, not on the watch's next pass; once per cluster at a time. */
export function replicateNow(clusterId: string): Promise<void> {
  const running = now.get(clusterId);
  if (running) return running;
  const p = replicateCluster(clusterId)
    .catch(quietly(clusterId))
    .finally(() => now.delete(clusterId));
  now.set(clusterId, p);
  return p;
}

/** Test seam: what replicateNow still has under way. */
export const __replicationsUnderWay = () => Promise.all(now.values());

/** Replication turned on or off: every member hears at once, in the background. */
export function replicateClusterSoon(clusterId: string): void {
  void replicateCluster(clusterId, true).catch(quietly(clusterId));
}

/** Every App with data on the cluster hands its leader a bundle that moves it, or makes it wait, as replication stands. */
export async function refreshVolumeAppBundles(
  clusterId: string,
): Promise<void> {
  for (const r of await appsOf(clusterId)) {
    const app = await loadAppGraph(r.id);
    if (app && appDisk(app) === "volume")
      await refreshAppBundle(r.id).catch(quietly(r.id));
  }
}

/** Test seam: forget what each member was handed. */
export function __forgetHandedTables(): void {
  handed.clear();
}
