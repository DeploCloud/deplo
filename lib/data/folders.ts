import "server-only";

import { cache } from "@/lib/request-cache";
import { and, eq, inArray, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { teamFolderOrder } from "../db/schema/control-plane/display-order";
import { folders as foldersTable } from "../db/schema/control-plane/projects";
import { getCurrentUser } from "../auth/current-user";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireMembership,
  requireCapability,
  hasCapability,
  isInstanceAdmin,
} from "../membership";
import {
  requireFolderCapability,
  canSeeFolder,
  visibleFolderIds,
} from "./folder-access";
import { appCapabilitiesForTeam, requireAppCapability } from "./node-access";
import { assertNotMigrating } from "./migration-guard";
import { recordActivity } from "./activity";
import { reapplyNetworkAfterMove } from "../deploy/build/reroute";
import { assertNoNameClash, withNetworkLock } from "./name-clash";
import { lostNeighbourMessage, neighboursLostByMove } from "./reachability";
import { composeNamesOnNetwork } from "../deploy/compose-stack/compose-read";
import { stackName } from "../deploy/deploy-key";
import { inFolderScope } from "../auth/request-context";
import { normalizeHexColor } from "../utils";
import { assembleFolder, folderToRow } from "./app-graph-rows/folder";
import type { Folder } from "../types/team";

export interface FolderSummary extends Folder {
  appCount: number;
  subfolderCount: number;
}

const MAX_NAME = 60;

function summarizeFolder(
  f: Folder,
  appCounts: Map<string, number>,
  subfolderCounts: Map<string, number>,
): FolderSummary {
  return {
    ...f,
    appCount: appCounts.get(f.id) ?? 0,
    subfolderCount: subfolderCounts.get(f.id) ?? 0,
  };
}

export function descendantFolderIds(
  folderId: string,
  folders: Pick<Folder, "id" | "parentId">[],
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const f of folders) {
    const p = f.parentId ?? null;
    if (p) childrenOf.set(p, [...(childrenOf.get(p) ?? []), f.id]);
  }
  const out = new Set<string>([folderId]);
  const stack = [folderId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of childrenOf.get(cur) ?? []) {
      if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
    }
  }
  return out;
}

export function rollUpAppCounts(
  folders: Pick<Folder, "id" | "parentId">[],
  direct: Map<string, number>,
): Map<string, number> {
  const byId = new Map(folders.map((f) => [f.id, f] as const));
  const totals = new Map<string, number>();
  for (const f of folders) {
    const n = direct.get(f.id) ?? 0;
    if (n === 0) continue;
    const seen = new Set<string>();
    let cur: Pick<Folder, "id" | "parentId"> | undefined = f;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      totals.set(cur.id, (totals.get(cur.id) ?? 0) + n);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return totals;
}

async function teamFoldersWithCounts(teamId: string): Promise<{
  folders: Folder[];
  appCounts: Map<string, number>;
  subfolderCounts: Map<string, number>;
}> {
  const folderRows = await getDb()
    .select()
    .from(foldersTable)
    .where(eq(foldersTable.teamId, teamId));
  const folders = folderRows.map(assembleFolder);
  const projRows = await getDb()
    .select({ folderId: appsTable.folderId })
    .from(appsTable)
    .where(eq(appsTable.teamId, teamId));
  const directCounts = new Map<string, number>();
  for (const r of projRows)
    if (r.folderId)
      directCounts.set(r.folderId, (directCounts.get(r.folderId) ?? 0) + 1);
  const appCounts = rollUpAppCounts(folders, directCounts);
  const subfolderCounts = new Map<string, number>();
  for (const f of folders)
    if (f.parentId)
      subfolderCounts.set(
        f.parentId,
        (subfolderCounts.get(f.parentId) ?? 0) + 1,
      );
  return { folders, appCounts, subfolderCounts };
}

export const listFolders = cache(async function listFolders(): Promise<
  FolderSummary[]
> {
  const teamId = await requireActiveTeamId();
  const { folders, appCounts, subfolderCounts } =
    await teamFoldersWithCounts(teamId);
  const rank = await folderOrderRank(teamId);
  const visible = await visibleFolderIds(teamId);
  const granted =
    visible === "all" ? folders : folders.filter((f) => visible.has(f.id));
  const seen = granted.filter((f) => inFolderScope(f.id));
  const shownSubfolderCounts =
    visible === "all"
      ? subfolderCounts
      : (() => {
          const m = new Map<string, number>();
          for (const f of seen)
            if (f.parentId && visible.has(f.parentId))
              m.set(f.parentId, (m.get(f.parentId) ?? 0) + 1);
          return m;
        })();
  return seen
    .map((f) => summarizeFolder(f, appCounts, shownSubfolderCounts))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
});

async function folderOrderRank(teamId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({
      folderId: teamFolderOrder.folderId,
      position: teamFolderOrder.position,
    })
    .from(teamFolderOrder)
    .where(eq(teamFolderOrder.teamId, teamId));
  return new Map(rows.map((r) => [r.folderId, r.position] as const));
}

export function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Folder name is required.");
  if (trimmed.length > MAX_NAME) {
    throw new Error(`Folder name must be ${MAX_NAME} characters or fewer.`);
  }
  return trimmed;
}

export function mergeOrder(orderedIds: string[], allIds: string[]): string[] {
  const valid = new Set(allIds);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of orderedIds) {
    if (valid.has(id) && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  for (const id of allIds) if (!seen.has(id)) next.push(id);
  return next;
}

export async function createFolder(
  name: string,
  color?: string | null,
  parentId?: string | null,
): Promise<FolderSummary> {
  const { teamId, userId } = await requireCapability("create_folders");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const clean = cleanName(name);
  const cleanColor = color ? normalizeHexColor(color) : null;
  if (parentId) {
    if (
      !(await folderInTeam(parentId, teamId)) ||
      !(await canSeeFolder(parentId))
    )
      throw new Error("Parent folder not found");
  }
  const folder: Folder = {
    id: newId("fld"),
    teamId,
    name: clean,
    parentId: parentId ?? null,
    color: cleanColor,
    ownerUserId: userId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await getDb().transaction(async (tx) => {
    await tx.insert(foldersTable).values(folderToRow(folder));
    const maxPos = await tx
      .select({ position: teamFolderOrder.position })
      .from(teamFolderOrder)
      .where(eq(teamFolderOrder.teamId, teamId));
    const next = maxPos.reduce((m, r) => Math.max(m, r.position + 1), 0);
    await tx
      .insert(teamFolderOrder)
      .values({ teamId, folderId: folder.id, position: next });
  });
  await recordActivity(
    "app",
    `Created folder ${folder.name}`,
    userName,
    null,
    teamId,
  );
  const { appCounts, subfolderCounts } = await teamFoldersWithCounts(teamId);
  return summarizeFolder(folder, appCounts, subfolderCounts);
}

async function folderInTeam(
  folderId: string,
  teamId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: foldersTable.id })
    .from(foldersTable)
    .where(eq(foldersTable.id, folderId))
    .limit(1);
  if (rows.length === 0) return false;
  const f = await getDb()
    .select({ teamId: foldersTable.teamId })
    .from(foldersTable)
    .where(eq(foldersTable.id, folderId))
    .limit(1);
  return f[0]?.teamId === teamId;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const { teamId, userName } = await requireFolderCapability(
    id,
    "organize_folders",
  );
  const clean = cleanName(name);
  const updated = await getDb()
    .update(foldersTable)
    .set({ name: clean, updatedAt: nowIso() })
    .where(
      and(
        eq(foldersTable.id, id),
        eq(foldersTable.teamId, teamId),
        ne(foldersTable.name, clean),
      ),
    )
    .returning({ id: foldersTable.id });
  if (updated.length === 0) {
    if (!(await folderInTeam(id, teamId))) throw new Error("Folder not found");
    return;
  }
  await recordActivity(
    "app",
    `Renamed folder to ${clean}`,
    userName,
    null,
    teamId,
  );
}

export async function setFolderColor(
  id: string,
  color: string | null,
): Promise<void> {
  const { teamId, userName } = await requireFolderCapability(
    id,
    "organize_folders",
  );
  const next = color ? normalizeHexColor(color) : null;
  const rows = await getDb()
    .select()
    .from(foldersTable)
    .where(and(eq(foldersTable.id, id), eq(foldersTable.teamId, teamId)))
    .limit(1);
  const f = rows[0];
  if (!f) throw new Error("Folder not found");
  if ((f.color ?? null) === next) return;
  await getDb()
    .update(foldersTable)
    .set({ color: next, updatedAt: nowIso() })
    .where(eq(foldersTable.id, id));
  await recordActivity(
    "app",
    next
      ? `Changed colour of folder ${f.name}`
      : `Cleared colour of folder ${f.name}`,
    userName,
    null,
    teamId,
  );
}

export async function moveFolder(
  id: string,
  parentId: string | null,
): Promise<void> {
  const { teamId, userName } = await requireFolderCapability(
    id,
    "organize_folders",
  );
  if (parentId && !(await canSeeFolder(parentId)))
    throw new Error("Folder not found");
  const { folders } = await teamFoldersWithCounts(teamId);
  const f = folders.find((x) => x.id === id);
  if (!f) throw new Error("Folder not found");
  let msg = "";
  if (parentId) {
    const parent = folders.find((x) => x.id === parentId);
    if (!parent) throw new Error("Folder not found");
    const blocked = descendantFolderIds(id, folders);
    if (blocked.has(parentId))
      throw new Error(
        "Can't move a folder into itself or one of its subfolders",
      );
    if ((f.parentId ?? null) === parentId) return;
    msg = `Moved folder ${f.name} into ${parent.name}`;
  } else {
    if ((f.parentId ?? null) == null) return;
    msg = `Moved folder ${f.name} to the top level`;
  }
  await getDb()
    .update(foldersTable)
    .set({ parentId: parentId ?? null, updatedAt: nowIso() })
    .where(eq(foldersTable.id, id));
  if (msg) await recordActivity("app", msg, userName, null, teamId);
}

export async function deleteFolder(
  id: string,
  opts: { deleteApps?: boolean } = {},
): Promise<void> {
  const { teamId, userName } = await requireFolderCapability(
    id,
    "delete_folders",
  );
  // Before the folder row goes, while its apps still resolve THROUGH it (ADR-0016).
  if (opts.deleteApps) {
    const { deleteAppsIn } = await import("./apps/bulk");
    await deleteAppsIn({ folderId: id });
  }
  const name = await getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(foldersTable)
      .where(and(eq(foldersTable.id, id), eq(foldersTable.teamId, teamId)))
      .limit(1);
    const f = rows[0];
    if (!f) throw new Error("Folder not found");
    const grandparent = f.parentId ?? null;
    await tx
      .update(appsTable)
      .set({ folderId: grandparent })
      .where(and(eq(appsTable.teamId, teamId), eq(appsTable.folderId, id)));
    await tx
      .update(foldersTable)
      .set({ parentId: grandparent })
      .where(
        and(eq(foldersTable.teamId, teamId), eq(foldersTable.parentId, id)),
      );
    await tx.delete(foldersTable).where(eq(foldersTable.id, id));
    return f.name;
  });
  await recordActivity("app", `Deleted folder ${name}`, userName, null, teamId);
}

export async function moveAppToFolder(
  appId: string,
  folderId: string | null,
): Promise<void> {
  const { teamId } = await requireAppCapability(appId, "move_apps");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const proj = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      folderId: appsTable.folderId,
    })
    .from(appsTable)
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
    .limit(1);
  const p = proj[0];
  if (!p) throw new Error("App not found");
  let msg = "";
  if (folderId) {
    if (!(await folderInTeam(folderId, teamId)))
      throw new Error("Folder not found");
    if (p.folderId === folderId) return;
    await requireFolderCapability(folderId, "move_apps");
    const f = await getDb()
      .select({ name: foldersTable.name })
      .from(foldersTable)
      .where(eq(foldersTable.id, folderId))
      .limit(1);
    msg = `Moved ${p.name} to ${f[0]?.name ?? ""}`;
  } else {
    if (p.folderId == null) return;
    msg = `Moved ${p.name} out of its folder`;
  }
  await withNetworkLock({ teamId, environmentId: null }, async () => {
    if (folderId) await assertAppNamesFreeAtTeamLevel([appId], teamId);
    await getDb()
      .update(appsTable)
      .set({
        folderId,
        ...(folderId ? { projectId: null, environmentId: null } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(appsTable.id, appId));
  });
  // The placement IS the network (ADR-0028), so the stack has to be brought up again to follow.
  await reapplyNetworkAfterMove([appId]);
  await warnLostNeighbours([appId], teamId, folderId ? null : null);
  if (msg) await recordActivity("app", msg, userName, appId, teamId);
}

export async function moveAppsToFolder(
  appIds: string[],
  folderId: string | null,
): Promise<number> {
  const { teamId } = await requireCapability("move_apps");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  let folderName = "";
  if (folderId) {
    const f = await getDb()
      .select({ name: foldersTable.name, teamId: foldersTable.teamId })
      .from(foldersTable)
      .where(eq(foldersTable.id, folderId))
      .limit(1);
    if (!f[0] || f[0].teamId !== teamId) throw new Error("Folder not found");
    await requireFolderCapability(folderId, "move_apps");
    folderName = f[0].name;
  }
  const owned = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      migrationRunId: appsTable.migrationRunId,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(
      and(
        eq(appsTable.teamId, teamId),
        inArray(appsTable.id, [...new Set(appIds)]),
      ),
    );
  const toMove = owned
    .filter((p) => (p.folderId ?? null) !== folderId)
    .map((p) => p.id);
  if (toMove.length === 0) return 0;
  const reach = await appCapabilitiesForTeam(
    teamId,
    owned
      .filter((p) => toMove.includes(p.id))
      .map((p) => ({
        id: p.id,
        folderId: p.folderId ?? null,
        projectId: p.projectId ?? null,
        environmentId: p.environmentId ?? null,
      })),
  );
  for (const id of toMove) {
    if (!(reach.get(id) ?? []).includes("move_apps"))
      throw new Error("App not found");
  }
  for (const p of owned)
    if (toMove.includes(p.id))
      assertNotMigrating("app", p.name, p.migrationRunId);
  await withNetworkLock({ teamId, environmentId: null }, async () => {
    if (folderId) await assertAppNamesFreeAtTeamLevel(toMove, teamId);
    await getDb()
      .update(appsTable)
      .set({
        folderId,
        ...(folderId ? { projectId: null, environmentId: null } : {}),
        updatedAt: nowIso(),
      })
      .where(inArray(appsTable.id, toMove));
  });
  await reapplyNetworkAfterMove(toMove);
  await warnLostNeighbours(toMove, teamId, null);
  const n = `${toMove.length} project${toMove.length === 1 ? "" : "s"}`;
  await recordActivity(
    "app",
    folderId ? `Moved ${n} to ${folderName}` : `Moved ${n} out of their folder`,
    userName,
    null,
    teamId,
  );
  return toMove.length;
}

export async function reorderFolders(orderedIds: string[]): Promise<void> {
  const { teamId } = await requireMembership();
  if (!(await isInstanceAdmin()) && !(await hasCapability("manage_team")))
    throw new Error("You don't have permission to reorder folders");
  await getDb().transaction(async (tx) => {
    const teamFolderIds = (
      await tx
        .select({ id: foldersTable.id })
        .from(foldersTable)
        .where(eq(foldersTable.teamId, teamId))
    ).map((r) => r.id);
    const next = mergeOrder(orderedIds, teamFolderIds);
    await tx.delete(teamFolderOrder).where(eq(teamFolderOrder.teamId, teamId));
    if (next.length > 0)
      await tx
        .insert(teamFolderOrder)
        .values(
          next.map((folderId, position) => ({ teamId, folderId, position })),
        );
  });
}

async function assertAppNamesFreeAtTeamLevel(
  appIds: string[],
  teamId: string,
): Promise<void> {
  const rows = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      compose: appsTable.compose,
      serverId: appsTable.serverId,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(inArray(appsTable.id, appIds));
  const takenByBatch = new Map<string, string>();
  for (const row of rows) {
    if (!row.environmentId) continue;
    const claims = row.compose?.trim()
      ? composeNamesOnNetwork(row.compose)
      : [stackName(row.slug)];
    for (const claim of claims) {
      const other = takenByBatch.get(claim.toLowerCase());
      if (other)
        throw new Error(
          `\`${claim}\` is answered by both ${other} and ${row.name}, which this ` +
            `move puts on one network. Rename it on one of them first.`,
        );
      takenByBatch.set(claim.toLowerCase(), row.name);
    }
    await assertNoNameClash({
      to: { teamId, environmentId: null, serverId: row.serverId },
      claims,
      exceptId: row.id,
      subject: "this app",
    });
  }
}

async function warnLostNeighbours(
  appIds: string[],
  teamId: string,
  environmentId: string | null,
): Promise<void> {
  for (const id of appIds) {
    try {
      const lost = await neighboursLostByMove(id, { teamId, environmentId });
      if (lost.length === 0) continue;
      const [row] = await getDb()
        .select({ name: appsTable.name })
        .from(appsTable)
        .where(eq(appsTable.id, id))
        .limit(1);
      await recordActivity(
        "app",
        lostNeighbourMessage(row?.name ?? "This app", lost),
        "Deplo",
        id,
        teamId,
      );
    } catch {}
  }
}
