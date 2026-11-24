import "server-only";

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  backupDestination,
  backupRuns,
} from "../../db/schema/control-plane/backups";
import { clusterAppReplicas } from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { AGENT_NO_ROOM, NO_ROOM_FOR_COPY } from "./replication";

// A copy that does not fit on a server is said on its row and its page (ADR-0043).
// https://deplo.build/docs/operations/clusters/replication#room

/** A backup refused before it started, in the words of `roomForBackup`. */
const NO_ROOM_FOR_BACKUP = "too little for this backup";

/** The copies each server cannot start for want of room, replicas and backups: the App and its size, to an admin only. */
export async function copiesWithoutRoom(
  serverIds: string[],
  viewer: { admin: boolean },
): Promise<Map<string, string>> {
  const lines = new Map<string, string[]>();
  if (serverIds.length === 0) return new Map();
  const add = (serverId: string, line: string) =>
    lines.set(serverId, [...(lines.get(serverId) ?? []), line]);
  const replicas = await getDb()
    .select({
      serverId: clusterAppReplicas.serverId,
      error: clusterAppReplicas.error,
    })
    .from(clusterAppReplicas)
    .where(inArray(clusterAppReplicas.serverId, serverIds));
  for (const r of replicas)
    if (r.error.includes(NO_ROOM_FOR_COPY))
      add(
        r.serverId,
        `${r.error}. Free some space on it, and the copy starts.`,
      );
  for (const b of await backupsWithoutRoom(serverIds))
    add(b.serverId, `Backup of ${b.name}: ${b.error.replace(/\.?$/, ".")}`);
  const out = new Map<string, string>();
  for (const [id, said] of lines)
    out.set(
      id,
      viewer.admin
        ? said.join(" ")
        : "A copy of an App does not fit on this server.",
    );
  return out;
}

/** The backups whose latest run on a server's disk, in the last day, was refused or stopped for room. */
async function backupsWithoutRoom(
  serverIds: string[],
): Promise<{ serverId: string; name: string; error: string }[]> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const runs = await getDb()
    .select({
      serverId: backupDestination.serverId,
      targetId: backupRuns.targetId,
      targetKind: backupRuns.targetKind,
      destinationId: backupRuns.destinationId,
      status: backupRuns.status,
      error: backupRuns.error,
    })
    .from(backupRuns)
    .innerJoin(
      backupDestination,
      eq(backupDestination.id, backupRuns.destinationId),
    )
    .where(
      and(
        eq(backupDestination.kind, "server"),
        inArray(backupDestination.serverId, serverIds),
        gte(backupRuns.startedAt, since),
      ),
    )
    .orderBy(desc(backupRuns.startedAt));
  const seen = new Set<string>();
  const out: { serverId: string; name: string; error: string }[] = [];
  for (const r of runs) {
    const key = `${r.targetId}|${r.destinationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const error = r.error ?? "";
    if (r.status !== "failed" || !r.serverId) continue;
    if (!error.includes(NO_ROOM_FOR_BACKUP) && !error.includes(AGENT_NO_ROOM))
      continue;
    out.push({ serverId: r.serverId, name: await nameOf(r), error });
  }
  return out;
}

async function nameOf(r: {
  targetKind: string;
  targetId: string;
}): Promise<string> {
  const table = r.targetKind === "database" ? databasesTable : appsTable;
  const [row] = await getDb()
    .select({ name: table.name })
    .from(table)
    .where(eq(table.id, r.targetId))
    .limit(1);
  return row?.name ?? "a deleted App";
}
