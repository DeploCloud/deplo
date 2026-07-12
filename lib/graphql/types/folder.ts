import { builder } from "../builder";
import {
  listFolders,
  createFolder,
  renameFolder,
  setFolderColor,
  deleteFolder,
  moveFolder,
  moveAppToFolder,
  moveAppsToFolder,
  reorderFolders,
  type FolderSummary,
} from "@/lib/data/folders";
import {
  folderCapabilities,
  folderIsOwnerOrAdmin,
  listFolderGrants,
  grantableFolderCapabilities,
  folderShareCandidates,
  setFolderGrant,
  removeFolderGrant,
  type FolderGrant,
} from "@/lib/data/folder-access";
import type { Capability } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Object type                                                         */
/* ------------------------------------------------------------------ */

export const FolderRef = builder.objectRef<FolderSummary>("Folder").implement({
  description:
    "A team-wide grouping of apps on the Overview. Apps reference their " +
    "folder via `App.folderId`; folders nest via `parentId` (a tree).",
  fields: (t) => ({
    id: t.exposeID("id"),
    teamId: t.exposeID("teamId"),
    name: t.exposeString("name"),
    parentId: t.exposeID("parentId", { nullable: true }),
    color: t.exposeString("color", { nullable: true }),
    ownerUserId: t.exposeID("ownerUserId", { nullable: true }),
    appCount: t.exposeInt("appCount"),
    subfolderCount: t.exposeInt("subfolderCount"),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt"),
    // The CURRENT caller's effective capabilities on this folder (team-bounded).
    // Drives per-folder action gating in the UI — rename/delete/move/share are
    // shown only when the relevant capability is present here.
    capabilities: t.field({
      type: ["String"],
      description:
        "The current caller's effective capabilities on this folder (bounded by their team caps).",
      resolve: (f) => folderCapabilities(f.id),
    }),
    // True when the caller may administer sharing for this folder — the owner or a
    // super-user (manage_team / instance admin). Gates the "Share folder" affordance.
    isOwner: t.field({
      type: "Boolean",
      description:
        "Whether the caller owns this folder or is a folder super-user (manage_team / admin).",
      resolve: (f) => folderIsOwnerOrAdmin(f.id),
    }),
  }),
});

/* ------------------------------------------------------------------ */
/* Folder grant (a shared user's per-folder access)                    */
/* ------------------------------------------------------------------ */

const FolderGrantRef = builder
  .objectRef<FolderGrant>("FolderGrant")
  .implement({
    description:
      "A user's access to a folder: the owner (isOwner=true, implicit) or a " +
      "grantee the owner has shared it with, plus their effective capabilities.",
    fields: (t) => ({
      folderId: t.exposeID("folderId"),
      userId: t.exposeID("userId"),
      username: t.exposeString("username"),
      name: t.exposeString("name"),
      avatarColor: t.exposeString("avatarColor"),
      capabilities: t.exposeStringList("capabilities"),
      isOwner: t.exposeBoolean("isOwner"),
    }),
  });

const FolderShareCandidateRef = builder
  .objectRef<{
    userId: string;
    username: string;
    name: string;
    avatarColor: string;
  }>("FolderShareCandidate")
  .implement({
    description:
      "A team member who could be granted access to a folder (used to populate the Share dialog's picker).",
    fields: (t) => ({
      userId: t.exposeID("userId"),
      username: t.exposeString("username"),
      name: t.exposeString("name"),
      avatarColor: t.exposeString("avatarColor"),
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
  folderGrants: t.field({
    type: [FolderGrantRef],
    // The data layer restricts this to the folder owner / super-user.
    authScopes: { loggedIn: true },
    description:
      "Who can access a folder — its owner plus every user it's shared with. Owner/admin only.",
    args: { folderId: t.arg.id({ required: true }) },
    resolve: (_r, { folderId }) => listFolderGrants(String(folderId)),
  }),
  grantableFolderCapabilities: t.field({
    type: ["String"],
    authScopes: { loggedIn: true },
    description:
      "The capabilities the caller may hand out on a folder (their own effective folder caps). Owner/admin only.",
    args: { folderId: t.arg.id({ required: true }) },
    resolve: (_r, { folderId }) => grantableFolderCapabilities(String(folderId)),
  }),
  folderShareCandidates: t.field({
    type: [FolderShareCandidateRef],
    authScopes: { loggedIn: true },
    description:
      "Team members who could be granted access to a folder (not the owner, not already granted). Owner/admin only.",
    args: {
      folderId: t.arg.id({ required: true }),
      query: t.arg.string({ required: false }),
    },
    resolve: (_r, { folderId, query }) =>
      folderShareCandidates(String(folderId), query ?? undefined),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

// `reorderFolders` writes the team-wide folder order (like reorderApps), so
// it stays gated on a super-user: an instance admin OR a member with manage_team.
const folderScopes = {
  $any: { instanceAdmin: true, capability: "manage_team" },
} as const;

// Every OTHER folder mutation is a PER-FOLDER decision (owner / grantee / super-
// user) that can't be expressed as a static team scope, so the GraphQL layer only
// requires a logged-in caller and the data layer performs the authoritative
// per-folder check (requireFolderCapability / requireFolderOwnerOrAdmin) — the
// same defense-in-depth pattern the app mutations use.
const perFolder = { loggedIn: true } as const;

builder.mutationFields((t) => ({
  createFolder: t.field({
    type: FolderRef,
    // Creating a folder requires `deploy` — the same gate as creating an app.
    authScopes: { capability: "deploy" },
    description:
      "Create a folder in the active team; nest it by passing a parent folder id. Requires the deploy capability; the creator becomes the folder's owner.",
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
    authScopes: perFolder,
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
    authScopes: perFolder,
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
    authScopes: perFolder,
    description: "Delete a folder; its apps fall back to the top level.",
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteFolder(String(id));
      return true;
    },
  }),
  moveAppToFolder: t.field({
    type: "Boolean",
    authScopes: perFolder,
    description:
      "Move an app into a folder, or back to the top level when folderId is omitted/null.",
    args: {
      appId: t.arg.id({ required: true }),
      folderId: t.arg.id({ required: false }),
    },
    resolve: async (_r, { appId, folderId }) => {
      await moveAppToFolder(
        String(appId),
        folderId != null ? String(folderId) : null,
      );
      return true;
    },
  }),
  moveFolder: t.field({
    type: "Boolean",
    authScopes: perFolder,
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
  moveAppsToFolder: t.field({
    type: "Int",
    authScopes: perFolder,
    description:
      "Bulk-move several apps into a folder (or to the top level when folderId is omitted/null) in one write. Returns how many moved.",
    args: {
      appIds: t.arg.idList({ required: true }),
      folderId: t.arg.id({ required: false }),
    },
    resolve: async (_r, { appIds, folderId }) =>
      moveAppsToFolder(
        appIds.map(String),
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
  setFolderGrant: t.field({
    type: [FolderGrantRef],
    authScopes: perFolder,
    description:
      "Grant (or replace) a user's capabilities on a folder. Bounded by both the granter's and the grantee's caps; owner/admin only. Returns the fresh grant list.",
    args: {
      folderId: t.arg.id({ required: true }),
      userId: t.arg.id({ required: true }),
      capabilities: t.arg.stringList({ required: true }),
    },
    resolve: (_r, { folderId, userId, capabilities }) =>
      setFolderGrant(
        String(folderId),
        String(userId),
        capabilities as Capability[],
      ),
  }),
  removeFolderGrant: t.field({
    type: [FolderGrantRef],
    authScopes: perFolder,
    description:
      "Revoke a user's access to a folder. Owner/admin only. Returns the fresh grant list.",
    args: {
      folderId: t.arg.id({ required: true }),
      userId: t.arg.id({ required: true }),
    },
    resolve: (_r, { folderId, userId }) =>
      removeFolderGrant(String(folderId), String(userId)),
  }),
}));
