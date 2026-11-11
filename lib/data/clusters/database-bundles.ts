import "server-only";

import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { RestoreRequest } from "../../agent/gen/agent";
import type {
  DatabaseDescriptor,
  ProjectDescriptor,
} from "../../agent/gen/agent";
import { backupRuns as runsTable } from "../../db/schema/control-plane/backups";
import {
  clusters as clustersTable,
  failoverBundlePushes as pushes,
} from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { encryptSecret, sha256Hex } from "../../crypto";
import type { BackupTargetKind } from "../../types/backup";
import type { Database } from "../../types/database";
import { assembleDatabase } from "../backup-rows";
import { restoreRequestFor } from "../backup-transport";
import { databaseDescriptor } from "../backups/target-descriptor";
import { mountsFor } from "../databases/rows";
import {
  databasePassword,
  renderDatabaseStackYaml,
  rerouteRequest,
} from "../databases/stack";
import { instanceFrozen } from "../deplo-move/freeze";
import {
  type DestinationWithSecrets,
  getDestinationWithSecretsForTeam,
} from "../destinations/credentials";
import { getServerById } from "../servers/roster";
import { dropLeaderBundle, listLeaderBundles } from "./bundle-calls";
import {
  type FailoverBundle,
  type FailoverRestore,
  cannotFailOver,
  deliver,
  hostFor,
  keyFingerprint,
  keyRows,
  recordOnce,
  refreshLeaderKeys,
} from "./bundles";
import { clusterMemberServerIds, getClusterById } from "./roster";

// A cluster database's failover bundle: its stack, and the backup another member restores before it starts (#202).
// https://deplo.build/docs/operations/clusters#when-a-server-stops

const KIND = "database";

/** A workload that keeps data, and what its agent needs to restore it. */
export interface RestoreTarget {
  kind: BackupTargetKind;
  id: string;
  teamId: string;
  /** The member it runs on now. */
  serverId: string;
  clusterId: string;
  database?: DatabaseDescriptor;
  project?: ProjectDescriptor;
}

/** `why` ends the sentence "x cannot fail over yet:"; null with no restore means no backup has finished yet. */
export type RestoreSource =
  | { restore: FailoverRestore; why: null }
  | { restore: null; why: string | null };

const nameOf = async (serverId: string | null) =>
  (serverId && (await getServerById(serverId))?.name) || "a server";

/**
 * The workload's latest backup that another member of its cluster can restore with Deplo away: one in a bucket,
 * or on the disk of a member other than its own. The request carries the destination's credentials.
 */
export async function latestRestorable(
  t: RestoreTarget,
): Promise<RestoreSource> {
  // ponytail: ticket #206's left-behind runs must be skipped here: nothing restores one on its own.
  const runs = await getDb()
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.teamId, t.teamId),
        eq(runsTable.targetKind, t.kind),
        eq(runsTable.targetId, t.id),
        eq(runsTable.status, "success"),
        isNull(runsTable.orphanedAt),
      ),
    )
    .orderBy(desc(runsTable.seq))
    .limit(20);
  const members = await clusterMemberServerIds(t.clusterId);
  const dests = new Map<string, DestinationWithSecrets | null>();
  let why: string | null = null;
  for (const run of runs) {
    if (!dests.has(run.destinationId))
      dests.set(
        run.destinationId,
        await getDestinationWithSecretsForTeam(
          t.teamId,
          run.destinationId,
        ).catch(() => null),
      );
    const creds = dests.get(run.destinationId);
    if (!creds) continue;
    const dest = creds.destination;
    if (dest.kind === "server" && dest.serverId === t.serverId) {
      why ??= `its backups are kept on ${await nameOf(dest.serverId)}, the server it runs on, so they would stop with it. Pick another destination for its backup.`;
      continue;
    }
    if (dest.kind === "server" && !members.includes(dest.serverId ?? "")) {
      why ??= `its backups are kept on ${await nameOf(dest.serverId)}, which is not in the cluster, so no server of the cluster can read them on its own. Keep its backup on another server of the cluster, or in a bucket.`;
      continue;
    }
    return {
      why: null,
      restore: {
        backupId: run.id,
        takenAt: run.startedAt,
        ...(dest.kind === "server" && dest.serverId
          ? { storeMember: dest.serverId }
          : {}),
        request: RestoreRequest.toJSON(
          restoreRequestFor(
            creds,
            { kind: t.kind, database: t.database, project: t.project },
            run.objectKey,
            run.sha256 ?? "",
          ),
        ),
      },
    };
  }
  return { restore: null, why };
}

// Deplo acting for itself has no session, which the team-scoped loader requires.
async function loadClusterDatabase(id: string): Promise<Database | null> {
  const [row] = await getDb()
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, id))
    .limit(1);
  return row?.clusterId ? assembleDatabase(row, await mountsFor(row.id)) : null;
}

/** Seals and sends a cluster database's bundle to every leader key that lacks this revision; says on Activity what keeps it from failing over. */
export async function pushDatabaseBundle(databaseId: string): Promise<void> {
  if (await instanceFrozen()) return;
  const db = await loadClusterDatabase(databaseId);
  if (!db?.clusterId || db.status === "provisioning") return;
  const cluster = await getClusterById(db.clusterId);
  if (!cluster) return;
  await refreshLeaderKeys(cluster);
  const keys = await keyRows(cluster.id);
  const say = (why: string) =>
    recordOnce(db, cannotFailOver(db.name, cluster.name, why), KIND);
  if (keys.length === 0) {
    await say(
      "Deplo could not reach the cluster's leader to hand it what it needs to restore this database elsewhere.",
    );
    return;
  }
  const sent = rerouteRequest(
    db,
    renderDatabaseStackYaml(db, databasePassword(db)),
  );
  const source = await latestRestorable({
    kind: KIND,
    id: db.id,
    teamId: db.teamId,
    serverId: db.serverId,
    clusterId: cluster.id,
    database: databaseDescriptor(db),
  });
  const body = {
    stack: {
      slug: sent.slug,
      projectId: db.id,
      // No image of its own: the member pulls what the stack names.
      imageRef: "",
      composeYaml: sent.composeYaml,
      network: sent.network,
      env: sent.env,
      registryAuth: [],
      composeUpArgs: sent.composeUpArgs,
      ...(sent.mounts.length > 0 ? { mounts: sent.mounts } : {}),
    },
    ...(source.restore ? { restore: source.restore } : {}),
  };
  const bundle: FailoverBundle = {
    v: 1,
    kind: KIND,
    workload: db.id,
    deploymentId: `rev_${sha256Hex(JSON.stringify(body)).slice(0, 24)}`,
    ...body,
  };
  const mine = and(eq(pushes.workloadKind, KIND), eq(pushes.workloadId, db.id));
  const rows = await getDb().select().from(pushes).where(mine);
  const lacking = keys.filter(
    (k) =>
      !rows.some(
        (r) =>
          r.keyFingerprint === keyFingerprint(k.publicKey) &&
          r.deploymentId === bundle.deploymentId &&
          r.pushedAt,
      ),
  );
  const failed =
    lacking.length === 0
      ? []
      : await deliver(
          cluster,
          bundle,
          encryptSecret(JSON.stringify(bundle)),
          lacking,
          {
            name: db.name,
            environment: db.environmentId ?? "",
            image: "",
            archs: [],
            limitMb: db.resources?.memoryMb ?? 0,
            peakMb: 0,
            hasDomain: false,
            createdAt: db.createdAt,
          },
        );
  await getDb()
    .delete(pushes)
    .where(
      and(
        mine,
        notInArray(
          pushes.keyFingerprint,
          keys.map((k) => keyFingerprint(k.publicKey)),
        ),
      ),
    );
  if (source.why) await say(source.why);
  if (failed.length > 0)
    await say(
      "the cluster's leader did not take its bundle. Deplo will send it again.",
    );
}

const inFlight = new Set<Promise<void>>();

/** Fire-and-forget after a backup or a move; what called it never waits on, or fails with, the leader. */
export function scheduleDatabaseBundle(databaseId: string): void {
  const p: Promise<void> = pushDatabaseBundle(databaseId)
    .catch((e) =>
      console.warn(
        `[failover-bundle] ${databaseId}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    )
    .finally(() => void inFlight.delete(p));
  inFlight.add(p);
}

/** Resolves once every scheduled push has settled. */
export async function flushDatabaseBundles(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

async function reconcileCluster(clusterId: string): Promise<void> {
  const cluster = await getClusterById(clusterId);
  if (!cluster) return;
  const db = getDb();
  const owned = await db
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(eq(databasesTable.clusterId, clusterId));
  const ids = new Set(owned.map((d) => d.id));
  for (const k of await keyRows(clusterId)) {
    const hostId = await hostFor(k.serverId).catch(() => null);
    if (!hostId) continue;
    const held = await listLeaderBundles(hostId, clusterId).catch(() => null);
    if (!held) continue;
    const here = held.filter((b) => b.kind === KIND);
    for (const b of here)
      if (!ids.has(b.id))
        await dropLeaderBundle(hostId, {
          cluster: clusterId,
          kind: KIND,
          id: b.id,
        }).catch(() => {});
    // A leader that lost what it was sent is sent it again.
    const kept = here.map((b) => b.id);
    const lost = owned.map((d) => d.id).filter((id) => !kept.includes(id));
    if (lost.length > 0)
      await db
        .update(pushes)
        .set({ pushedAt: null })
        .where(
          and(
            eq(pushes.workloadKind, KIND),
            eq(pushes.keyFingerprint, keyFingerprint(k.publicKey)),
            inArray(pushes.workloadId, lost),
          ),
        );
  }
  // ponytail: a changed password or setting reaches the leader here or with the next backup, not at the edit.
  for (const d of owned) await pushDatabaseBundle(d.id);
}

/** The sweep's job: every cluster's leaders hold each database's stack and latest backup as they are now. */
export async function reconcileDatabaseBundles(): Promise<void> {
  if (await instanceFrozen()) return;
  const rows = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable);
  for (const r of rows)
    await reconcileCluster(r.id).catch((e) =>
      console.warn(
        `[failover-bundle] ${r.id}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
}
