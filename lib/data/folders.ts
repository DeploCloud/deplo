import "server-only";

import { read, mutate } from "../store";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireMembership,
  requireCapability,
  isInstanceAdmin,
} from "../membership";
import { recordActivity } from "./activity";
import { normalizeHexColor } from "../utils";
import type { Folder, Project } from "../types";

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
  teamProjects: Project[],
  teamFolders: Folder[],
): FolderSummary {
  return {
    ...f,
    projectCount: teamProjects.filter((p) => p.folderId === f.id).length,
    subfolderCount: teamFolders.filter((x) => x.parentId === f.id).length,
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

/**
 * Folders in the active team, honouring the team-wide manual order (Overview
 * drag-and-drop) when present and falling back to newest-first — the same
 * contract as `listProjects`. Each carries a live project count.
 */
export async function listFolders(): Promise<FolderSummary[]> {
  const teamId = await requireActiveTeamId();
  const d = read();
  const order = d.teams.find((t) => t.id === teamId)?.folderOrder ?? [];
  const rank = new Map(order.map((id, i) => [id, i] as const));
  const teamProjects = d.projects.filter((p) => p.teamId === teamId);
  const teamFolders = d.folders.filter((f) => f.teamId === teamId);
  return teamFolders
    .map((f) => summarizeFolder(f, teamProjects, teamFolders))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
}

/**
 * Gate every folder mutation exactly like the team-wide project order
 * (`reorderProjects`): an instance admin (who bypasses team capabilities) or a
 * member holding `manage_team`. Returns the acting user's display name + the
 * active team for the audit log.
 */
async function requireFolderManage(): Promise<{
  teamId: string;
  userName: string;
}> {
  const { teamId } = await requireMembership();
  if (!(await isInstanceAdmin())) {
    await requireCapability("manage_team");
  }
  const userName = (await getCurrentUser())?.name ?? "Someone";
  return { teamId, userName };
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
  const { teamId, userName } = await requireFolderManage();
  const clean = cleanName(name);
  // Normalise at the trust boundary so every stored colour is a canonical
  // `#rrggbb`; an empty/absent choice keeps the default neutral tile.
  const cleanColor = color ? normalizeHexColor(color) : null;
  // A nested folder must be created under a real folder of the same team; an
  // unknown/foreign parent is rejected so a stale client can't strand a subtree.
  if (parentId) {
    const parent = read().folders.find(
      (x) => x.id === parentId && x.teamId === teamId,
    );
    if (!parent) throw new Error("Parent folder not found");
  }
  const folder: Folder = {
    id: newId("fld"),
    teamId,
    name: clean,
    parentId: parentId ?? null,
    color: cleanColor,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  mutate((d) => {
    d.folders.push(folder);
    // Append to the team's folder order so a brand-new folder lands last in the
    // grid rather than jumping ahead of existing, deliberately-ordered ones.
    const team = d.teams.find((t) => t.id === teamId);
    if (team) team.folderOrder = [...(team.folderOrder ?? []), folder.id];
  });
  recordActivity("project", `Created folder ${folder.name}`, userName, null, teamId);
  const d = read();
  return summarizeFolder(
    folder,
    d.projects.filter((p) => p.teamId === teamId),
    d.folders.filter((f) => f.teamId === teamId),
  );
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const { teamId, userName } = await requireFolderManage();
  const clean = cleanName(name);
  let changed = false;
  mutate((d) => {
    const f = d.folders.find((x) => x.id === id && x.teamId === teamId);
    if (!f) throw new Error("Folder not found");
    if (f.name === clean) return;
    f.name = clean;
    f.updatedAt = nowIso();
    changed = true;
  });
  if (changed) {
    recordActivity("project", `Renamed folder to ${clean}`, userName, null, teamId);
  }
}

/**
 * Set (or clear, with `null`/empty) a folder's accent colour. The colour is
 * normalised to a canonical `#rrggbb` at this boundary so a stale/odd client
 * value can't be persisted; the readable foreground is derived at render time,
 * never stored. No-op (no updatedAt bump, no activity) when unchanged.
 */
export async function setFolderColor(
  id: string,
  color: string | null,
): Promise<void> {
  const { teamId, userName } = await requireFolderManage();
  const next = color ? normalizeHexColor(color) : null;
  let changed = false;
  let name = "";
  mutate((d) => {
    const f = d.folders.find((x) => x.id === id && x.teamId === teamId);
    if (!f) throw new Error("Folder not found");
    name = f.name;
    if ((f.color ?? null) === next) return;
    f.color = next;
    f.updatedAt = nowIso();
    changed = true;
  });
  if (changed) {
    recordActivity(
      "project",
      next ? `Changed colour of folder ${name}` : `Cleared colour of folder ${name}`,
      userName,
      null,
      teamId,
    );
  }
}

/**
 * Move a folder under a new parent, or to the top level when `parentId` is null.
 * Both folders must belong to the active team. A folder can't be moved into
 * itself or any of its own descendants (that would orphan a cycle) — such a move
 * is rejected. No-op (no updatedAt bump, no activity) when already in place.
 */
export async function moveFolder(
  id: string,
  parentId: string | null,
): Promise<void> {
  const { teamId, userName } = await requireFolderManage();
  let msg = "";
  mutate((d) => {
    const f = d.folders.find((x) => x.id === id && x.teamId === teamId);
    if (!f) throw new Error("Folder not found");
    if (parentId) {
      const parent = d.folders.find(
        (x) => x.id === parentId && x.teamId === teamId,
      );
      if (!parent) throw new Error("Folder not found");
      const blocked = descendantFolderIds(
        id,
        d.folders.filter((x) => x.teamId === teamId),
      );
      if (blocked.has(parentId)) {
        throw new Error("Can't move a folder into itself or one of its subfolders");
      }
      if ((f.parentId ?? null) === parentId) return;
      f.parentId = parentId;
      msg = `Moved folder ${f.name} into ${parent.name}`;
    } else {
      if ((f.parentId ?? null) == null) return;
      f.parentId = null;
      msg = `Moved folder ${f.name} to the top level`;
    }
    f.updatedAt = nowIso();
  });
  if (msg) recordActivity("project", msg, userName, null, teamId);
}

/**
 * Delete a folder. Nothing inside is deleted: its projects and its CHILD folders
 * are re-parented to the deleted folder's own parent (so a nested subtree stays
 * intact one level up, rather than scattering to the top). The id is also dropped
 * from the team's folderOrder.
 */
export async function deleteFolder(id: string): Promise<void> {
  const { teamId, userName } = await requireFolderManage();
  let name = "";
  let found = false;
  mutate((d) => {
    const f = d.folders.find((x) => x.id === id && x.teamId === teamId);
    if (!f) throw new Error("Folder not found");
    name = f.name;
    found = true;
    const grandparent = f.parentId ?? null;
    // Projects in the folder fall to its parent (or the top level if none).
    for (const p of d.projects) {
      if (p.teamId === teamId && p.folderId === id) p.folderId = grandparent;
    }
    // Child folders re-parent to the grandparent so the subtree survives.
    for (const child of d.folders) {
      if (child.teamId === teamId && child.parentId === id) {
        child.parentId = grandparent;
      }
    }
    d.folders = d.folders.filter((x) => x.id !== id);
    const team = d.teams.find((t) => t.id === teamId);
    if (team?.folderOrder) {
      team.folderOrder = team.folderOrder.filter((fid) => fid !== id);
    }
  });
  if (found) {
    recordActivity("project", `Deleted folder ${name}`, userName, null, teamId);
  }
}

/**
 * Move a project into a folder, or back to the top level when `folderId` is
 * null. Both the project and the target folder must belong to the active team;
 * an unknown folder is rejected so a stale client can't strand a project under a
 * phantom id. No-op (no updatedAt bump, no activity) when already in place.
 */
export async function moveProjectToFolder(
  projectId: string,
  folderId: string | null,
): Promise<void> {
  const { teamId, userName } = await requireFolderManage();
  let msg = "";
  mutate((d) => {
    const p = d.projects.find((x) => x.id === projectId && x.teamId === teamId);
    if (!p) throw new Error("Project not found");
    if (folderId) {
      const f = d.folders.find((x) => x.id === folderId && x.teamId === teamId);
      if (!f) throw new Error("Folder not found");
      if (p.folderId === folderId) return;
      p.folderId = folderId;
      msg = `Moved ${p.name} to ${f.name}`;
    } else {
      if (p.folderId == null) return;
      p.folderId = null;
      msg = `Moved ${p.name} out of its folder`;
    }
    p.updatedAt = nowIso();
  });
  if (msg) recordActivity("project", msg, userName, projectId, teamId);
}

/**
 * Move SEVERAL projects into a folder (or to the top level when `folderId` is
 * null) in a SINGLE store write — the bulk counterpart to `moveProjectToFolder`,
 * so a multi-select move costs one document persist + one activity row instead of
 * N. Team-scoped: only the caller's own team projects are touched; foreign/stale
 * ids and projects already in place are skipped. Returns how many actually moved.
 */
export async function moveProjectsToFolder(
  projectIds: string[],
  folderId: string | null,
): Promise<number> {
  const { teamId, userName } = await requireFolderManage();
  const idSet = new Set(projectIds);
  let moved = 0;
  let folderName = "";
  mutate((d) => {
    if (folderId) {
      const f = d.folders.find((x) => x.id === folderId && x.teamId === teamId);
      if (!f) throw new Error("Folder not found");
      folderName = f.name;
    }
    const now = nowIso();
    for (const p of d.projects) {
      if (p.teamId !== teamId || !idSet.has(p.id)) continue;
      if ((p.folderId ?? null) === folderId) continue;
      p.folderId = folderId;
      p.updatedAt = now;
      moved++;
    }
  });
  if (moved > 0) {
    const n = `${moved} project${moved === 1 ? "" : "s"}`;
    recordActivity(
      "project",
      folderId ? `Moved ${n} to ${folderName}` : `Moved ${n} out of their folder`,
      userName,
      null,
      teamId,
    );
  }
  return moved;
}

/**
 * Persist the team-wide order of folders in the Overview grid. Same total-and-
 * self-healing contract as `reorderProjects`: ids are sanitised to the caller's
 * own team folders (dropping unknown/duplicate ids) and any team folder the
 * client omitted is appended, so the stored order is always total.
 */
export async function reorderFolders(orderedIds: string[]): Promise<void> {
  const { teamId } = await requireFolderManage();
  mutate((d) => {
    const team = d.teams.find((t) => t.id === teamId);
    if (!team) return;
    const teamFolderIds = d.folders
      .filter((f) => f.teamId === teamId)
      .map((f) => f.id);
    team.folderOrder = mergeOrder(orderedIds, teamFolderIds);
  });
}
