import "server-only";

import { and, asc, eq, isNull, ne, or } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  backupDestination as destTable,
  backupRuns as runsTable,
} from "../../db/schema/control-plane/backups";
import { clusterMembers as membersTable } from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { BACKUP_STORE_SEALED_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { connectBackupAgent } from "../../infra/agent-client/preflight";
import type { BackupDestination } from "../../types/backup";
import type { Cluster } from "../../types/cluster";
import { newId, nowIso } from "../../ids";
import { serverLabel } from "../../utils";
import { formatBytes } from "../backups/format-bytes";
import {
  getDestinationWithSecretsForTeam,
  storeTargetFor,
} from "../destinations/credentials";
import { latestDisk } from "./facts";

// A member leaves its cluster only with nothing to lose: each backup it keeps for the cluster moves first (c48).

export interface KeptBackup {
  id: string;
  teamId: string;
  destinationId: string;
  objectKey: string;
  sizeBytes: number;
  sha256: string | null;
  /** The App or database it is a backup of. */
  name: string;
}

/** The backups `serverId` keeps on its disk for the Apps and databases of `clusterId`, oldest first. */
export async function keptBackups(
  clusterId: string,
  serverId: string,
): Promise<KeptBackup[]> {
  const rows = await getDb()
    .select({
      id: runsTable.id,
      teamId: runsTable.teamId,
      destinationId: runsTable.destinationId,
      objectKey: runsTable.objectKey,
      sizeBytes: runsTable.sizeBytes,
      sha256: runsTable.sha256,
      app: appsTable.name,
      database: databasesTable.name,
    })
    .from(runsTable)
    .innerJoin(destTable, eq(destTable.id, runsTable.destinationId))
    .leftJoin(appsTable, eq(appsTable.id, runsTable.appId))
    .leftJoin(databasesTable, eq(databasesTable.id, runsTable.databaseId))
    .where(
      and(
        eq(destTable.kind, "server"),
        eq(destTable.serverId, serverId),
        eq(runsTable.status, "success"),
        isNull(runsTable.copiedFrom),
        ne(runsTable.objectKey, ""),
        or(
          eq(appsTable.clusterId, clusterId),
          eq(databasesTable.clusterId, clusterId),
        ),
      ),
    )
    .orderBy(asc(runsTable.startedAt), asc(runsTable.id));
  return rows.map(({ app, database, ...r }) => ({
    ...r,
    name: app ?? database ?? "",
  }));
}

/** The member with the most disk free that keeps a tenth of it free with `bytes` more; an unknown disk comes last. */
async function roomiest(
  cluster: Cluster,
  fromId: string,
  bytes: number,
): Promise<{ id: string; name: string } | null> {
  const others = await getDb()
    .select({ id: serversTable.id, name: serversTable.name })
    .from(membersTable)
    .innerJoin(serversTable, eq(serversTable.id, membersTable.serverId))
    .where(
      and(
        eq(membersTable.clusterId, cluster.id),
        ne(membersTable.serverId, fromId),
        isNull(membersTable.emptyingSince),
        eq(membersTable.leaseState, "ok"),
        ne(serversTable.status, "offline"),
        ne(serversTable.agentCertFingerprint, ""),
      ),
    );
  const fits = others
    .map((o) => ({ ...o, disk: latestDisk(o.id) }))
    .filter(
      (o) => o.disk.total === 0 || o.disk.free - bytes >= o.disk.total / 10,
    )
    .sort((a, b) => b.disk.free - a.disk.free);
  return fits[0] ?? null;
}

// The copy keeps the key it was encrypted to: a destination on the new member that shares it, or a new one.
async function siblingOn(
  teamId: string,
  from: BackupDestination,
  to: { id: string; name: string },
): Promise<{ id: string; path: string | null }> {
  const [same] = await getDb()
    .select({ id: destTable.id, path: destTable.path })
    .from(destTable)
    .where(
      and(
        eq(destTable.teamId, teamId),
        eq(destTable.kind, "server"),
        eq(destTable.serverId, to.id),
        from.ageRecipient
          ? eq(destTable.ageRecipient, from.ageRecipient)
          : isNull(destTable.ageRecipient),
      ),
    )
    .limit(1);
  if (same) return same;
  const id = newId("dst");
  await getDb()
    .insert(destTable)
    .values({
      id,
      teamId,
      name: `${serverLabel(to)} (from ${from.name})`,
      kind: "server",
      serverId: to.id,
      ageRecipient: from.ageRecipient,
      ageIdentityEnc: from.ageIdentityEnc,
      recoveryKeySavedAt: from.recoveryKeySavedAt,
      status: "unverified",
      createdAt: nowIso(),
    });
  return { id, path: null };
}

/**
 * Copies one backup to the roomiest other member, checks what landed against its size and digest, then points the
 * run there and deletes it from `from`. Throws with why when it cannot; nothing changes then.
 * ponytail: a base backup moves without the change log shipped beside it (no store listing); its own time restores.
 */
export async function moveKeptBackup(
  cluster: Cluster,
  from: { id: string; name: string },
  b: KeptBackup,
): Promise<string> {
  const what = `backup of ${b.name || "a workload"} (${formatBytes(b.sizeBytes)})`;
  const to = await roomiest(cluster, from.id, b.sizeBytes);
  if (!to)
    throw new Error(
      `No other server of cluster ${cluster.name} has room for the ${what} that ${from.name} keeps.`,
    );
  const src = (
    await getDestinationWithSecretsForTeam(b.teamId, b.destinationId)
  ).destination;
  const dst = await siblingOn(b.teamId, src, to);
  const sourceFile = storeTargetFor(src, b.objectKey);
  const landedFile = { root: dst.path ?? "", objectKey: b.objectKey };
  const reader = await connectBackupAgent(from.id, { store: true });
  try {
    const sink = await connectBackupAgent(to.id, { store: true });
    try {
      const sealed = (await sink.hello()).capabilities?.includes(
        BACKUP_STORE_SEALED_CAPABILITY,
      );
      const landed = await sink.writeStoreFile(
        landedFile,
        true,
        reader.readStoreFile({ store: sourceFile }),
        undefined,
        sealed
          ? () => ({ sizeBytes: b.sizeBytes, sha256: b.sha256 ?? "" })
          : undefined,
      );
      const wrong = !landed.ok
        ? landed.error || "it gave no reason"
        : landed.bytesWritten !== b.sizeBytes
          ? `${landed.bytesWritten} of its ${b.sizeBytes} bytes landed`
          : b.sha256 &&
              landed.sha256 &&
              b.sha256.toLowerCase() !== landed.sha256.toLowerCase()
            ? "what landed does not match it"
            : "";
      if (wrong) {
        await sink.storeDelete(landedFile).catch(() => {});
        throw new Error(
          `The ${what} did not move from ${from.name} to ${to.name}: ${wrong}.`,
        );
      }
    } finally {
      sink.close();
    }
    await getDb()
      .update(runsTable)
      .set({ destinationId: dst.id })
      .where(
        and(
          eq(runsTable.id, b.id),
          eq(runsTable.destinationId, b.destinationId),
        ),
      );
    // The run reads from its new home now; what is left here only takes room.
    await reader.storeDelete(sourceFile).catch(() => {});
  } finally {
    reader.close();
  }
  return to.name;
}
