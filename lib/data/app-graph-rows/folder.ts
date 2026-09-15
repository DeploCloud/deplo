import "server-only";

import type { Folder } from "../../types/team";
import type { folders } from "../../db/schema/control-plane/projects";

export type FolderRow = typeof folders.$inferSelect;

export function assembleFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    parentId: row.parentId,
    projectId: row.projectId ?? null,
    color: row.color,
    ownerUserId: row.ownerUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function folderToRow(f: Folder): typeof folders.$inferInsert {
  return {
    id: f.id,
    teamId: f.teamId,
    name: f.name,
    parentId: f.parentId ?? null,
    projectId: f.projectId ?? null,
    color: f.color ?? null,
    ownerUserId: f.ownerUserId ?? null,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}
