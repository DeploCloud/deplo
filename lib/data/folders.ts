import "server-only";

import { and, eq, inArray, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  folders as foldersTable,
  projects as projectsTable,
  teamFolderOrder,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
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
import { recordActivity } from "./activity";
import { normalizeHexColor } from "../utils";
import { assembleFolder, folderToRow } from "./project-graph-rows";
import type { Folder } from "../types";

export interface FolderSummary extends Folder {
  /** Live count of projects DIRECTLY in this folder (derived, never stored). */
  projectCount: number;
  /** Live count of immediate child folders (derived, never stored). */
  subfolderCount: number;
}

/** Cap folder names so one can't break the grid layout or the audit log. */
const MAX_NAME = 60;

function summarizeFolder(
  f: Folder,
  projectCounts: Map<string, number>,
  subfolderCounts: Map<string, number>,
): FolderSummary {
  return {
    ...f,
    projectCount: projectCounts.get(f.id) ?? 0,
    subfolderCount: subfolderCounts.get(f.id) ?? 0,
  };
}

/**
 * The id of `folderId` plus every folder nested anywhere beneath it (its whole
 * subtree). Used to reject a move that would put a folder under its own
 * descendant — which would orphan a cycle out of the tree. Pure over the given
 * folder list.
 */
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

/** A team's folders (assembled) + live project/subfolder counts (one query each). */
async function teamFoldersWithCounts(
  teamId: string,
): Promise<{
  folders: Folder[];
  projectCounts: Map<string, number>;
  subfolderCounts: Map<string, number>;
}> {
  const folderRows = await getDb()
    .select()
    .from(foldersTable)
    .where(eq(foldersTable.teamId, teamId));
  const folders = folderRows.map(assembleFolder);
  // Project counts: GROUP BY folder_id over the team's projects.
  const projRows = await getDb()
    .select({ folderId: projectsTable.folderId })
    .from(projectsTable)
    .where(eq(projectsTable.teamId, teamId));
  const projectCounts = new Map<string, number>();
  for (const r of projRows)
    if (r.folderId) projectCounts.set(r.folderId, (projectCounts.get(r.folderId) ?? 0) + 1);
  const subfolderCounts = new Map<string, number>();
  for (const f of folders)
    if (f.parentId)
      subfolderCounts.set(f.parentId, (subfolderCounts.get(f.parentId) ?? 0) + 1);
  return { folders, projectCounts, subfolderCounts };
}

/**
 * Folders in the active team, honouring the team-wide manual order (Overview
 * drag-and-drop) when present and falling back to newest-first — the same
 * contract as `listProjects`. Each carries a live project count.
 */
export async function listFolders(): Promise<FolderSummary[]> {
  const teamId = await requireActiveTeamId();
  const { folders, projectCounts, subfolderCounts } =
    await teamFoldersWithCounts(teamId);
  const rank = await folderOrderRank(teamId);
  // Only surface folders the caller may SEE: the ones they own or hold a grant
  // on, or every folder when they're a super-user (admin / manage_team).
  const visible = await visibleFolderIds(teamId);
  const seen = visible === "all" ? folders : folders.filter((f) => visible.has(f.id));
  // Recompute subfolderCount over the VISIBLE set so a folder doesn't disclose the
  // existence of child folders the caller can't see (child folders carry their own
  // independent ownership/grants). projectCount stays team-scoped — a folder's
  // projects are part of what any folder-viewer works with. Super-users (visible
  // === "all") keep the full team counts.
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
    .map((f) => summarizeFolder(f, projectCounts, shownSubfolderCounts))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
}

/** Team-wide manual folder order (the `team_folder_order` junction), id→rank. */
async function folderOrderRank(teamId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ folderId: teamFolderOrder.folderId, position: teamFolderOrder.position })
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

/**
 * Reconcile a client-supplied display order against the authoritative id set:
 * keep the requested ids that are valid (dropping unknown/duplicate ones, in
 * order), then append any authoritative id the client omitted (preserving its
 * existing position) so the stored order is always total and self-healing. Pure;
 * shared by `reorderFolders` and exercised directly in tests.
 */
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
  // Creating a folder needs the SAME capability as creating a project: `deploy`.
  // The creator becomes the folder's owner and its per-folder caps are derived
  // live from their team caps (never stored) — see lib/data/folder-access.ts.
  const { teamId, userId } = await requireCapability("deploy");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const clean = cleanName(name);
  // Normalise at the trust boundary so every stored colour is a canonical
  // `#rrggbb`; an empty/absent choice keeps the default neutral tile.
  const cleanColor = color ? normalizeHexColor(color) : null;
  // A nested folder must be created under a real folder of the same team that the
  // creator can actually SEE — an unknown/foreign/invisible parent is rejected so
  // a stale client can't strand a subtree or nest under someone else's folder.
  if (parentId) {
    if (!(await folderInTeam(parentId, teamId)) || !(await canSeeFolder(parentId)))
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
  // Append to the team's folder order so a brand-new folder lands last in the
  // grid rather than jumping ahead of existing, deliberately-ordered ones.
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
  await recordActivity("project", `Created folder ${folder.name}`, userName, null, teamId);
  const { projectCounts, subfolderCounts } = await teamFoldersWithCounts(teamId);
  return summarizeFolder(folder, projectCounts, subfolderCounts);
}

/** True if a folder belongs to a team. */
async function folderInTeam(folderId: string, teamId: string): Promise<boolean> {
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
  const { teamId, userName } = await requireFolderCapability(id, "deploy");
  const clean = cleanName(name);
  // No-op when unchanged (conditional UPDATE … RETURNING); verify existence only
  // when nothing changed so a rename-to-same-name doesn't error.
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
  await recordActivity("project", `Renamed folder to ${clean}`, userName, null, teamId);
}

/**
 * Set (or clear, with `null`/empty) a folder's accent colour. Normalised to a
 * canonical `#rrggbb` at this boundary. No-op (no updatedAt bump, no activity)
 * when unchanged.
 */
export async function setFolderColor(
  id: string,
  color: string | null,
): Promise<void> {
  const { teamId, userName } = await requireFolderCapability(id, "deploy");
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
    "project",
    next ? `Changed colour of folder ${f.name}` : `Cleared colour of folder ${f.name}`,
    userName,
    null,
    teamId,
  );
}

/**
 * Move a folder under a new parent, or to the top level when `parentId` is null.
 * Both folders must belong to the active team. A folder can't be moved into
 * itself or any of its own descendants (rejected). No-op when already in place.
 */
export async function moveFolder(
  id: string,
  parentId: string | null,
): Promise<void> {
  // Manage the moved folder itself, AND (when nesting) be able to see the
  // destination parent — so a user can't file a folder under one they can't use.
  const { teamId, userName } = await requireFolderCapability(id, "deploy");
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
      throw new Error("Can't move a folder into itself or one of its subfolders");
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
  if (msg) await recordActivity("project", msg, userName, null, teamId);
}

/**
 * Delete a folder. Nothing inside is deleted: its projects and its CHILD folders
 * are re-parented to the deleted folder's own parent (so a nested subtree stays
 * intact one level up). The team_folder_order row CASCADEs on the delete.
 */
export async function deleteFolder(id: string): Promise<void> {
  const { teamId, userName } = await requireFolderCapability(id, "deploy");
  await getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(foldersTable)
      .where(and(eq(foldersTable.id, id), eq(foldersTable.teamId, teamId)))
      .limit(1);
    const f = rows[0];
    if (!f) throw new Error("Folder not found");
    const grandparent = f.parentId ?? null;
    // Projects in the folder fall to its parent (or the top level if none).
    await tx
      .update(projectsTable)
      .set({ folderId: grandparent })
      .where(and(eq(projectsTable.teamId, teamId), eq(projectsTable.folderId, id)));
    // Child folders re-parent to the grandparent so the subtree survives.
    await tx
      .update(foldersTable)
      .set({ parentId: grandparent })
      .where(and(eq(foldersTable.teamId, teamId), eq(foldersTable.parentId, id)));
    // The team_folder_order row CASCADEs when the folder row is deleted.
    await tx.delete(foldersTable).where(eq(foldersTable.id, id));
    await recordActivity("project", `Deleted folder ${f.name}`, userName, null, teamId);
  });
}

/**
 * Move a project into a folder, or back to the top level when `folderId` is
 * null. No-op when already in place.
 */
export async function moveProjectToFolder(
  projectId: string,
  folderId: string | null,
): Promise<void> {
  const { teamId } = await requireCapability("deploy");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const proj = await getDb()
    .select({ id: projectsTable.id, name: projectsTable.name, folderId: projectsTable.folderId })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.teamId, teamId)))
    .limit(1);
  const p = proj[0];
  if (!p) throw new Error("Project not found");
  // Pulling a project OUT of its current folder needs `deploy` on that source
  // folder (a no-op when the project is already at the top level). This blocks
  // a member from evicting a project from a folder they don't control.
  if (p.folderId && p.folderId !== folderId) {
    await requireFolderCapability(p.folderId, "deploy");
  }
  let msg = "";
  if (folderId) {
    // Filing INTO a folder needs `deploy` on that destination folder.
    if (!(await folderInTeam(folderId, teamId))) throw new Error("Folder not found");
    if (p.folderId === folderId) return;
    await requireFolderCapability(folderId, "deploy");
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
  await getDb()
    .update(projectsTable)
    .set({ folderId, updatedAt: nowIso() })
    .where(eq(projectsTable.id, projectId));
  if (msg) await recordActivity("project", msg, userName, projectId, teamId);
}

/**
 * Move SEVERAL projects into a folder (or to the top level) in one write — the
 * bulk counterpart to `moveProjectToFolder`. Team-scoped; foreign/stale ids and
 * projects already in place are skipped. Returns how many actually moved.
 */
export async function moveProjectsToFolder(
  projectIds: string[],
  folderId: string | null,
): Promise<number> {
  const { teamId } = await requireCapability("deploy");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  let folderName = "";
  if (folderId) {
    const f = await getDb()
      .select({ name: foldersTable.name, teamId: foldersTable.teamId })
      .from(foldersTable)
      .where(eq(foldersTable.id, folderId))
      .limit(1);
    if (!f[0] || f[0].teamId !== teamId) throw new Error("Folder not found");
    // Filing INTO a folder needs `deploy` on that destination folder.
    await requireFolderCapability(folderId, "deploy");
    folderName = f[0].name;
  }
  // Only the caller's own team projects that actually change folder.
  const owned = await getDb()
    .select({ id: projectsTable.id, folderId: projectsTable.folderId })
    .from(projectsTable)
    .where(and(eq(projectsTable.teamId, teamId), inArray(projectsTable.id, [...new Set(projectIds)])));
  const toMove = owned
    .filter((p) => (p.folderId ?? null) !== folderId)
    .map((p) => p.id);
  if (toMove.length === 0) return 0;
  // Pulling projects OUT of their current folders needs `deploy` on each distinct
  // source folder the selection touches — so a member can't evict projects from a
  // folder they don't control via the bulk path.
  const sourceFolders = new Set(
    owned
      .filter((p) => (p.folderId ?? null) !== folderId && p.folderId)
      .map((p) => p.folderId as string),
  );
  for (const src of sourceFolders) {
    await requireFolderCapability(src, "deploy");
  }
  await getDb()
    .update(projectsTable)
    .set({ folderId, updatedAt: nowIso() })
    .where(inArray(projectsTable.id, toMove));
  const n = `${toMove.length} project${toMove.length === 1 ? "" : "s"}`;
  await recordActivity(
    "project",
    folderId ? `Moved ${n} to ${folderName}` : `Moved ${n} out of their folder`,
    userName,
    null,
    teamId,
  );
  return toMove.length;
}

/**
 * Persist the team-wide order of folders in the Overview grid. Same total-and-
 * self-healing contract as `reorderProjects`: ids are sanitised to the caller's
 * own team folders, any omitted team folder is appended, and the
 * `team_folder_order` junction is rewritten over the survivors.
 */
export async function reorderFolders(orderedIds: string[]): Promise<void> {
  // The Overview folder order is a single TEAM-WIDE setting (like reorderProjects),
  // so a lone folder owner can't define it — gate on the super-user role.
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
        .values(next.map((folderId, position) => ({ teamId, folderId, position })));
  });
}
