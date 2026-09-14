import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  appVolumes as appVolumesTable,
  apps as appsTable,
} from "../../db/schema/control-plane/apps";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { stackFilesDir } from "../../deploy/deploy-key";

import type { SourceCredential } from "../../migration/source";
import {
  composeHostMounts,
  normalizePath,
} from "../../migration/map/volume-discovery";

import { runTargets } from "./landed-targets";
import { sourceServices, type SourceService } from "./source-services";

/**
 * Which OTHER app on one machine mounts a host path. Cross-team on purpose: a bind
 * is a path on the box, and the copy WIPES its target before writing - two apps that
 * both mount /opt/data is all it takes for the second migration to erase the first.
 */
export async function hostPathOwners(
  serverId: string | null | undefined,
  exceptAppId: string,
  /** The team reading the note: another team's app is named as exactly that. */
  teamId?: string,
): Promise<{ appId: string; name: string; path: string }[]> {
  if (!serverId) return [];
  const rows = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      compose: appsTable.compose,
      teamId: appsTable.teamId,
    })
    .from(appsTable)
    .where(eq(appsTable.serverId, serverId));
  const mine = rows
    .filter((r) => r.id !== exceptAppId)
    .map((r) => ({
      ...r,
      name: teamId && r.teamId !== teamId ? "another team's app" : r.name,
    }));
  if (mine.length === 0) return [];
  const mounts = await getDb()
    .select({
      appId: appVolumesTable.appId,
      hostPath: appVolumesTable.hostPath,
    })
    .from(appVolumesTable)
    .where(eq(appVolumesTable.type, "host"));
  const named = new Map(mine.map((r) => [r.id, r.name] as const));
  const out: { appId: string; name: string; path: string }[] = [];
  for (const m of mounts) {
    const name = named.get(m.appId);
    if (name && (m.hostPath ?? "").trim())
      out.push({ appId: m.appId, name, path: normalizePath(m.hostPath!) });
  }
  for (const r of mine)
    for (const h of composeHostMounts(r.compose ?? "", stackFilesDir(r.slug)))
      out.push({ appId: r.id, name: r.name, path: normalizePath(h.hostPath) });
  return out;
}

/** Equal, inside, or containing: any of the three and a wipe takes the other one out. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Is the app that owns a clashing path another service of THIS run, from the
 * same source machine as `svc`? Then it is the same directory over there, and one
 * copy fills it for both - not a stranger's data about to be wiped.
 */
export async function runTwinFor(
  c: SourceCredential,
  runId: string,
  svc: SourceService,
  ownerAppId: string,
): Promise<boolean> {
  const targets = await runTargets(runId);
  const sourceId = [...targets].find(
    ([, t]) => t.targetKind === "app" && t.targetId === ownerAppId,
  )?.[0];
  if (!sourceId || sourceId === svc.id) return false;
  const other = (await sourceServices(c)).find((s) => s.id === sourceId);
  return other != null && other.serverId === svc.serverId;
}

/** A host path this run already filled - itself or a parent of it. */
export async function copiedInRun(
  runId: string,
  targetPath: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ message: itemsTable.message })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.runId, runId),
        eq(itemsTable.sourceKind, "volume"),
        eq(itemsTable.outcome, "created"),
      ),
    );
  return rows.some((r) => {
    const m = /^Copied .* into (\S+) \(/.exec(r.message ?? "");
    return (
      m != null && (m[1] === targetPath || targetPath.startsWith(`${m[1]}/`))
    );
  });
}
