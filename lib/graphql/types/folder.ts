import { builder } from "../builder";
import {
  listFolders,
  createFolder,
  renameFolder,
  setFolderColor,
  deleteFolder,
  moveFolder,
  moveProjectToFolder,
  moveProjectsToFolder,
  reorderFolders,
  type FolderSummary,
} from "@/lib/data/folders";

/* ------------------------------------------------------------------ */
/* Object type                                                         */
/* ------------------------------------------------------------------ */

export const FolderRef = builder.objectRef<FolderSummary>("Folder").implement({
  description:
    "A team-wide grouping of projects on the Overview. Projects reference their " +
    "folder via `Project.folderId`; folders nest via `parentId` (a tree).",
  fields: (t) => ({
    id: t.exposeID("id"),
    teamId: t.exposeID("teamId"),
    name: t.exposeString("name"),
    parentId: t.exposeID("parentId", { nullable: true }),
    color: t.exposeString("color", { nullable: true }),
    projectCount: t.exposeInt("projectCount"),
    subfolderCount: t.exposeInt("subfolderCount"),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt"),
  }),
});

/* ------------------------------------------------------------------ */
/* Query                                                               */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  folders: t.field({
    type: [FolderRef],
    authScopes: { loggedIn: true },
    description: "All folders in the active team, in display order.",
    resolve: () => listFolders(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

// Folders mirror the team-wide project order: managing them is gated on an
// instance admin OR a member with manage_team. The data layer re-checks the
// same gate (defense-in-depth).
const folderScopes = {
  $any: { instanceAdmin: true, capability: "manage_team" },
} as const;

builder.mutationFields((t) => ({
  createFolder: t.field({
    type: FolderRef,
    authScopes: folderScopes,
    description:
      "Create a folder in the active team; nest it by passing a parent folder id.",
    args: {
      name: t.arg.string({ required: true }),
      color: t.arg.string({ required: false }),
      parentId: t.arg.id({ required: false }),
    },
    resolve: (_r, { name, color, parentId }) =>
      createFolder(name, color ?? null, parentId != null ? String(parentId) : null),
  }),
  renameFolder: t.field({
    type: "Boolean",
    authScopes: folderScopes,
    description: "Rename a folder.",
    args: {
      id: t.arg.id({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, name }) => {
      await renameFolder(String(id), name);
      return true;
    },
  }),
  setFolderColor: t.field({
    type: "Boolean",
    authScopes: folderScopes,
    description:
      "Set a folder's accent colour (hex, e.g. #3b82f6), or clear it back to the default when color is omitted/null.",
    args: {
      id: t.arg.id({ required: true }),
      color: t.arg.string({ required: false }),
    },
    resolve: async (_r, { id, color }) => {
      await setFolderColor(String(id), color ?? null);
      return true;
    },
  }),
  deleteFolder: t.field({
    type: "Boolean",
    authScopes: folderScopes,
    description: "Delete a folder; its projects fall back to the top level.",
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteFolder(String(id));
      return true;
    },
  }),
  moveProjectToFolder: t.field({
    type: "Boolean",
    authScopes: folderScopes,
    description:
      "Move a project into a folder, or back to the top level when folderId is omitted/null.",
    args: {
      projectId: t.arg.id({ required: true }),
      folderId: t.arg.id({ required: false }),
    },
    resolve: async (_r, { projectId, folderId }) => {
      await moveProjectToFolder(
        String(projectId),
        folderId != null ? String(folderId) : null,
      );
      return true;
    },
  }),
  moveFolder: t.field({
    type: "Boolean",
    authScopes: folderScopes,
    description:
      "Move a folder under a new parent folder, or to the top level when parentId is omitted/null. Rejects moving a folder into itself or a descendant.",
    args: {
      id: t.arg.id({ required: true }),
      parentId: t.arg.id({ required: false }),
    },
    resolve: async (_r, { id, parentId }) => {
      await moveFolder(String(id), parentId != null ? String(parentId) : null);
      return true;
    },
  }),
  moveProjectsToFolder: t.field({
    type: "Int",
    authScopes: folderScopes,
    description:
      "Bulk-move several projects into a folder (or to the top level when folderId is omitted/null) in one write. Returns how many moved.",
    args: {
      projectIds: t.arg.idList({ required: true }),
      folderId: t.arg.id({ required: false }),
    },
    resolve: async (_r, { projectIds, folderId }) =>
      moveProjectsToFolder(
        projectIds.map(String),
        folderId != null ? String(folderId) : null,
      ),
  }),
  reorderFolders: t.field({
    type: "Boolean",
    authScopes: folderScopes,
    description: "Set the team-wide display order of folders in Overview.",
    args: { folderIds: t.arg.idList({ required: true }) },
    resolve: async (_r, { folderIds }) => {
      await reorderFolders(folderIds.map(String));
      return true;
    },
  }),
}));
