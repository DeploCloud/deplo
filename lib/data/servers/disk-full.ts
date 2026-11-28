import "server-only";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusterAppReplicas } from "../../db/schema/control-plane/clusters";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { getMetricsHistory } from "../../monitoring/history";
import { formatBytes } from "../backups/format-bytes";
import { appDisk } from "../../apps/failover-copy";
import { loadAppGraph } from "../app-graph-load";
import { appOwnVolumeNames } from "../project-backup-descriptor";
import { recordActivity } from "../activity";
import { volumeBytes } from "../clusters/data-size";
import { nowIso } from "../../ids";

// A disk past 90% used, whatever filled it, is said on its server's row and page and once in Activity (ADR-0043).
export const DISK_FULL_PCT = 90;
/** Back under this, it is said again the next time it passes DISK_FULL_PCT. */
const DISK_CLEAR_PCT = 88;

interface Holder {
  name: string;
  bytes: number;
  teamId: string;
}

/** What takes a server's disk, biggest first: its Apps' volumes and the copies it keeps of other servers' Apps. */
async function biggestOn(serverId: string): Promise<Holder[]> {
  const out: Holder[] = [];
  const db = getDb();
  const running = await db
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(eq(appsTable.serverId, serverId));
  for (const { id } of running) {
    const app = await loadAppGraph(id);
    if (!app || appDisk(app) !== "volume") continue;
    const names = appOwnVolumeNames(app);
    if (names.length === 0) continue;
    const bytes = await volumeBytes(serverId, names).catch(() => 0);
    if (bytes > 0) out.push({ name: app.name, bytes, teamId: app.teamId });
  }
  const copies = await db
    .select({
      name: appsTable.name,
      teamId: appsTable.teamId,
      bytes: clusterAppReplicas.bytes,
    })
    .from(clusterAppReplicas)
    .innerJoin(appsTable, eq(appsTable.id, clusterAppReplicas.appId))
    .where(
      and(
        eq(clusterAppReplicas.serverId, serverId),
        eq(clusterAppReplicas.role, "receiving"),
      ),
    );
  for (const c of copies)
    if (c.bytes > 0)
      out.push({
        name: `a copy of ${c.name}`,
        bytes: c.bytes,
        teamId: c.teamId,
      });
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** The sentence a full disk shows: how full, and the three biggest things on it. */
export function diskFullSentence(
  server: string,
  pct: number,
  biggest: { name: string; bytes: number }[],
): string {
  const top = biggest
    .slice(0, 3)
    .map((h) => `${h.name} (${formatBytes(h.bytes)})`)
    .join(", ");
  return (
    `${server}'s disk is ${Math.floor(pct)}% full.` +
    (top ? ` Biggest: ${top}.` : "") +
    " Free some space on it, or Apps there cannot write."
  );
}

/** The servers whose disk is past 90% used now, with their sentence; servers pages are for instance admins only. */
export async function diskWarnings(
  servers: { id: string; name: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of servers) {
    const last = getMetricsHistory(s.id).at(-1);
    if (!last || Date.now() - last.ts > 120_000) continue;
    if (!(last.diskPct > DISK_FULL_PCT)) continue;
    out.set(
      s.id,
      diskFullSentence(s.name, last.diskPct, await biggestOn(s.id)),
    );
  }
  return out;
}

/**
 * Activity says once that a server's disk passed 90%, in the team whose data takes the most of it and naming only
 * that team's; it is said again only after the disk went back under 88%.
 */
export async function noteDiskUse(
  serverId: string,
  serverName: string,
  pct: number,
): Promise<void> {
  const db = getDb();
  if (pct < DISK_CLEAR_PCT) {
    await db
      .update(serversTable)
      .set({ diskFullAt: null })
      .where(
        and(eq(serversTable.id, serverId), isNotNull(serversTable.diskFullAt)),
      );
    return;
  }
  if (!(pct > DISK_FULL_PCT)) return;
  const claimed = await db
    .update(serversTable)
    .set({ diskFullAt: nowIso() })
    .where(and(eq(serversTable.id, serverId), isNull(serversTable.diskFullAt)))
    .returning({ id: serversTable.id });
  if (claimed.length === 0) return;
  const biggest = await biggestOn(serverId);
  const teamId = biggest[0]?.teamId ?? null;
  await recordActivity(
    "server",
    diskFullSentence(
      serverName,
      pct,
      biggest.filter((h) => h.teamId === teamId),
    ),
    "system",
    null,
    teamId,
  );
}
