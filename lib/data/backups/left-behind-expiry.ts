import "server-only";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  backupDestination as destTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { recordActivity } from "../activity";
import { deleteFromDestination } from "../backup-transport";
import {
  destinationServerId,
  getDestinationWithSecretsForTeam,
} from "../destinations/credentials";
import { ownsArtifact } from "./copied-runs";
import { formatBytes } from "../../utils";
import { diskFull, FULL_SHARE } from "./room";
import { anyBackupCapableServer } from "./target-lookup";

const DAY_MS = 24 * 60 * 60_000;

/**
 * What a returning member saved as a "Left on" backup follows the set-aside rule: the newest per workload per server
 * stays, an older one goes after 7 days, or after 1 once the disk it is kept on is past 80% used.
 */
export async function expireLeftBehindRuns(now = Date.now()): Promise<void> {
  const db = getDb();
  const runs = await db
    .select({
      id: backupRunsTable.id,
      teamId: backupRunsTable.teamId,
      appId: backupRunsTable.appId,
      databaseId: backupRunsTable.databaseId,
      targetId: backupRunsTable.targetId,
      destinationId: backupRunsTable.destinationId,
      objectKey: backupRunsTable.objectKey,
      sizeBytes: backupRunsTable.sizeBytes,
      status: backupRunsTable.status,
      copiedFrom: backupRunsTable.copiedFrom,
      leftAt: backupRunsTable.leftAt,
      leftOn: backupRunsTable.leftOnServerId,
      destKind: destTable.kind,
      destServerId: destTable.serverId,
    })
    .from(backupRunsTable)
    .innerJoin(destTable, eq(destTable.id, backupRunsTable.destinationId))
    .where(
      and(
        isNotNull(backupRunsTable.leftAt),
        eq(backupRunsTable.status, "success"),
      ),
    )
    .orderBy(desc(backupRunsTable.leftAt));
  const newest = new Set<string>();
  const old = runs.filter((r) => {
    const key = `${r.targetId}:${r.leftOn}`;
    if (!newest.has(key)) {
      newest.add(key);
      return false;
    }
    const full = r.destKind === "server" && diskFull(r.destServerId);
    return Date.parse(r.leftAt!) < now - (full ? 1 : 7) * DAY_MS;
  });
  if (old.length === 0) return;

  // Ids carry their kind's prefix, so one map names Apps, databases and servers.
  const ids = (pick: (r: (typeof old)[number]) => (string | null)[]) => [
    "",
    ...old.flatMap((r) => pick(r).filter((v): v is string => !!v)),
  ];
  const names = new Map(
    (
      await Promise.all([
        db
          .select({ id: appsTable.id, name: appsTable.name })
          .from(appsTable)
          .where(
            inArray(
              appsTable.id,
              ids((r) => [r.appId]),
            ),
          ),
        db
          .select({ id: databasesTable.id, name: databasesTable.name })
          .from(databasesTable)
          .where(
            inArray(
              databasesTable.id,
              ids((r) => [r.databaseId]),
            ),
          ),
        db
          .select({ id: serversTable.id, name: serversTable.name })
          .from(serversTable)
          .where(
            inArray(
              serversTable.id,
              ids((r) => [r.leftOn, r.destServerId]),
            ),
          ),
      ])
    )
      .flat()
      .map((r) => [r.id, r.name]),
  );
  const nameOf = (id: string | null) => names.get(id ?? "");

  for (const r of old) {
    try {
      if (ownsArtifact(r)) {
        const creds = await getDestinationWithSecretsForTeam(
          r.teamId,
          r.destinationId,
        );
        const via =
          destinationServerId(creds.destination, "") ||
          (await anyBackupCapableServer());
        if (!via) continue;
        // File first, row second, or the file outlives everything that names it.
        if (!(await deleteFromDestination(creds, via, r.objectKey!)).ok)
          continue;
      }
      await db
        .delete(backupRunsTable)
        .where(
          and(
            eq(backupRunsTable.id, r.id),
            eq(backupRunsTable.teamId, r.teamId),
          ),
        );
    } catch {
      // A destination that does not answer keeps the file until the next sweep.
      continue;
    }
    const left = nameOf(r.leftOn) ?? "its server";
    const full = r.destKind === "server" && diskFull(r.destServerId);
    await recordActivity(
      "backup",
      `Removed the backup of ${nameOf(r.appId) ?? nameOf(r.databaseId) ?? "a deleted workload"} that ${left} left on ${r.leftAt!.slice(0, 16).replace("T", " ")} UTC (${formatBytes(r.sizeBytes ?? 0)}): ` +
        (full
          ? `${nameOf(r.destServerId) ?? "the server it was kept on"} is more than ${FULL_SHARE * 100}% full, and a newer one is kept.`
          : "it was older than 7 days, and a newer one is kept."),
      "Deplo",
      r.appId,
      r.teamId,
      null,
      r.databaseId,
    );
  }
}
