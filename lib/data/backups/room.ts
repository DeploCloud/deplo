import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { backupRuns as backupRunsTable } from "../../db/schema/control-plane/backups";
import { VOLUME_USAGE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { connectBackupAgent } from "../../infra/agent-client/preflight";
import type { TransportTarget } from "../backup-transport";
import {
  destinationServerId,
  storeTargetFor,
  type DestinationWithSecrets,
} from "../destinations/credentials";
import { getServerById } from "../servers/roster";
import { latestDisk } from "../clusters/facts";
import { formatBytes } from "./format-bytes";

/** A disk past this share used hands Deplo's own backups to a member with more room, and keeps fewer set-aside copies. */
export const FULL_SHARE = 0.8;

/** Its disk is past FULL_SHARE used, as its last metrics said; unknown is not full. */
export function diskFull(serverId: string | null | undefined): boolean {
  const d = latestDisk(serverId ?? "");
  return d.total > 0 && d.free < d.total * (1 - FULL_SHARE);
}

/** What a backup will write: an App's volumes as they are now, or a database's last dump. */
async function expectedBytes(
  target: TransportTarget,
  targetId: string,
): Promise<number> {
  const vols = target.project?.volumeNames.filter(Boolean) ?? [];
  if (vols.length > 0) {
    const conn = await connectBackupAgent(target.serverId);
    try {
      const hello = await conn.hello();
      if (!hello.capabilities?.includes(VOLUME_USAGE_CAPABILITY)) return 0;
      let sum = 0;
      for (const n of (await conn.volumeUsage(vols)).values()) sum += n;
      return sum;
    } finally {
      conn.close();
    }
  }
  // ponytail: a Postgres base backup or change log has no estimate; the destination's own write says if it is full.
  if (target.kind !== "database" || target.archive) return 0;
  const [last] = await getDb()
    .select({ size: backupRunsTable.sizeBytes })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.targetId, targetId),
        eq(backupRunsTable.status, "success"),
        isNull(backupRunsTable.leftOnServerId),
      ),
    )
    .orderBy(desc(backupRunsTable.startedAt))
    .limit(1);
  return last?.size ?? 0;
}

/**
 * A backup never fills a disk (ADR-0043): it starts only when what it will write leaves a tenth of its destination
 * server's disk free. Returns why it does not start, or null.
 */
export async function roomForBackup(
  creds: DestinationWithSecrets,
  target: TransportTarget,
  targetId: string,
): Promise<string | null> {
  const dest = creds.destination;
  if (dest.kind !== "server") return null;
  const need = await expectedBytes(target, targetId);
  if (need <= 0) return null;
  const serverId = destinationServerId(dest, target.serverId);
  const conn = await connectBackupAgent(serverId, { store: true });
  let check: Awaited<ReturnType<typeof conn.storeCheck>>;
  try {
    check = await conn.storeCheck(storeTargetFor(dest, ""));
  } finally {
    conn.close();
  }
  if (!check.ok || check.totalBytes <= 0) return null;
  if (check.freeBytes - need >= check.totalBytes / 10) return null;
  const name =
    (await getServerById(serverId))?.name ?? "The destination server";
  return (
    `${name} has ${formatBytes(check.freeBytes)} free, too little for this backup ` +
    `(about ${formatBytes(need)}) and a tenth of its disk free, so it did not start`
  );
}
