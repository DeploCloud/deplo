"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { reorderBlock } from "@/lib/reorder-block";
import { gqlAction } from "@/lib/graphql-client";
import type { GridArrangement } from "./grid-arrangement";
import type { AppsGridProps } from "./grid-contract";

const REORDER_SERVICES = `mutation($ids: [ID!]!) { reorderApps(appIds: $ids) }`;
const REORDER_FOLDERS = `mutation($ids: [ID!]!) { reorderFolders(folderIds: $ids) }`;
const REORDER_PROJECT_CONTAINERS = `mutation($ids: [ID!]!) { reorderProjects(projectIds: $ids) }`;
const MOVE_TO_FOLDER = `mutation($appId: ID!, $folderId: ID) { moveAppToFolder(appId: $appId, folderId: $folderId) }`;
const MOVE_SERVICE_TO_PROJECT = `mutation($appId: ID!, $projectId: ID) { moveAppToProject(appId: $appId, projectId: $projectId) }`;
const DELETE_FOLDER = `mutation($id: ID!, $deleteApps: Boolean) { deleteFolder(id: $id, deleteApps: $deleteApps) }`;
const DELETE_PROJECT = `mutation($id: ID!, $deleteApps: Boolean) { deleteProject(id: $id, deleteApps: $deleteApps) }`;
const MOVE_FOLDER = `mutation($id: ID!, $parentId: ID) { moveFolder(id: $id, parentId: $parentId) }`;
// Bulk variants: each is ONE server round-trip + ONE store write for the whole
// selection (instead of N fanned-out per-id mutations).
const BULK_MOVE = `mutation($ids: [ID!]!, $folderId: ID) { moveAppsToFolder(appIds: $ids, folderId: $folderId) }`;
const BULK_DELETE = `mutation($ids: [ID!]!) { deleteApps(ids: $ids) }`;

// useGridMutations is every server write the grid performs, each with its own
// optimistic hide and the revert that puts a refused card back.
export function useGridMutations({
  arrangement,
  openFolder,
  clearSelection,
  selectedAppIds,
  selectedFolderIds,
  selectedProjectIds,
  bulkDeleteApps,
  onDeleted,
  onRestored,
}: {
  arrangement: GridArrangement;
  openFolder: AppsGridProps["openFolder"];
  clearSelection: () => void;
  selectedAppIds: string[];
  selectedFolderIds: string[];
  selectedProjectIds: string[];
  bulkDeleteApps: boolean;
  onDeleted: (ids: string[]) => void;
  onRestored: (ids: string[]) => void;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const {
    order,
    setOrder,
    folderOrder,
    setFolderOrder,
    projectOrder,
    setProjectOrder,
    setMovedIds,
    folderItems,
    projectItems,
  } = arrangement;

  function bulkMoveTo(folderId: string | null) {
    const ids = selectedAppIds;
    if (ids.length === 0) return;
    startTransition(async () => {
      const res = await gqlAction(BULK_MOVE, { ids, folderId });
      if (res.ok) {
        toast.success(`Moved ${ids.length} app${ids.length === 1 ? "" : "s"}`);
        clearSelection();
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // `onCreated` for the "New folder with selection" flow: move the selected
  // apps into the folder the dialog just created (one bulk call).
  async function moveSelectionInto(folderId: string) {
    const ids = selectedAppIds;
    if (ids.length) await gqlAction(BULK_MOVE, { ids, folderId });
    clearSelection();
  }

  async function bulkDelete() {
    const appIds = selectedAppIds;
    const folderIds = selectedFolderIds;
    const projectIds = selectedProjectIds;
    const all = [...appIds, ...folderIds, ...projectIds];
    // Every card goes on the CLICK, like a single delete does. A partial
    // failure puts them all back and the refresh below re-hides whatever really
    // went - the same contract `moveAppsToProject` uses for a batch.
    onDeleted(all);
    // Apps go through ONE bulk mutation (one server write, bounded-
    // concurrency teardown); folders and projects (usually few) delete per id.
    const results = await Promise.all([
      ...(appIds.length ? [gqlAction(BULK_DELETE, { ids: appIds })] : []),
      ...folderIds.map((id) =>
        gqlAction(DELETE_FOLDER, { id, deleteApps: bulkDeleteApps }),
      ),
      ...projectIds.map((id) =>
        gqlAction(DELETE_PROJECT, { id, deleteApps: bulkDeleteApps }),
      ),
    ]);
    router.refresh();
    const failed = results.find((r) => !r.ok);
    // Clear only on FULL success: a partial failure keeps the still-selected
    // items so re-confirming retries them and the error stays meaningful, and
    // keeps their cards, for the same reason.
    if (!failed) clearSelection();
    else onRestored(all);
    return failed ?? { ok: true as const, data: undefined };
  }

  function persistReorder(mutation: string, ids: string[], revert: () => void) {
    startTransition(async () => {
      const res = await gqlAction(mutation, { ids });
      if (res.ok) router.refresh();
      else {
        toast.error(res.error);
        revert();
      }
    });
  }

  function moveApp(appId: string, folderId: string | null) {
    setMovedIds((prev) => new Set(prev).add(appId));
    startTransition(async () => {
      const res = await gqlAction(MOVE_TO_FOLDER, { appId, folderId });
      if (res.ok) {
        toast.success(folderId ? "Moved to folder" : "Moved out of folder");
        router.refresh();
      } else {
        toast.error(res.error);
        setMovedIds((prev) => {
          const next = new Set(prev);
          next.delete(appId);
          return next;
        });
      }
    });
  }

  // Move nested SUB-FOLDERS out one level - to the open folder's own parent, or to
  // the top level when that parent is a root. One call each (no bulk endpoint).
  function moveFoldersOut(ids: string[]) {
    if (ids.length === 0) return;
    const dest = openFolder?.parentId ?? null;
    setMovedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    startTransition(async () => {
      const results = await Promise.all(
        ids.map((id) => gqlAction(MOVE_FOLDER, { id, parentId: dest })),
      );
      const failed = results.find((r) => !r.ok);
      if (!failed) {
        toast.success(
          ids.length === 1
            ? "Moved out of folder"
            : `Moved ${ids.length} folders out`,
        );
        if (ids.length > 1) clearSelection();
      } else {
        toast.error(failed.error);
        setMovedIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }
      router.refresh();
    });
  }

  // Move an app into a project container (or out, when projectId is null),
  // with the same optimistic hide + refresh contract as moveApp.
  function moveAppToProject(appId: string, projectId: string | null) {
    setMovedIds((prev) => new Set(prev).add(appId));
    startTransition(async () => {
      const res = await gqlAction(MOVE_SERVICE_TO_PROJECT, {
        appId,
        projectId,
      });
      if (res.ok) {
        toast.success(
          projectId ? "Moved into project" : "Moved out of project",
        );
        router.refresh();
      } else {
        toast.error(res.error);
        setMovedIds((prev) => {
          const next = new Set(prev);
          next.delete(appId);
          return next;
        });
      }
    });
  }

  // The multi-selection variant: one mutation per app (no bulk endpoint),
  // fired together and settled with a single refresh.
  function moveAppsToProject(ids: string[], projectId: string | null) {
    if (ids.length === 0) return;
    setMovedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    startTransition(async () => {
      const results = await Promise.all(
        ids.map((appId) =>
          gqlAction(MOVE_SERVICE_TO_PROJECT, { appId, projectId }),
        ),
      );
      const failed = results.find((r) => !r.ok);
      if (!failed) {
        toast.success(`Moved ${ids.length} app${ids.length === 1 ? "" : "s"}`);
        clearSelection();
      } else {
        toast.error(failed.error);
        // Revert the whole batch's optimistic hide (like the single-item move): if EVERY
        // mutation failed the refresh returns identical props, the sig never changes, and
        // un-reverted ids would stay invisible forever.
        setMovedIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }
      // Refresh either way: a partial failure re-reveals whatever didn't move.
      router.refresh();
    });
  }

  // The three reorders share one rule: the lifted card carries its whole
  // multi-selection (`block`), and moves alone when it isn't part of one.
  function reorderAppList(activeId: string, overId: string, block: string[]) {
    const next = reorderBlock(order, activeId, overId, block);
    if (!next) return;
    const previous = order;
    setOrder(next);
    persistReorder(REORDER_SERVICES, next, () => setOrder(previous));
  }

  function reorderFolderList(
    activeId: string,
    overId: string,
    block: string[],
  ) {
    const next = reorderBlock(
      folderItems.map((f) => f.id),
      activeId,
      overId,
      block,
    );
    if (!next) return;
    const previous = folderOrder;
    setFolderOrder(next);
    persistReorder(REORDER_FOLDERS, next, () => setFolderOrder(previous));
  }

  function reorderProjectList(
    activeId: string,
    overId: string,
    block: string[],
  ) {
    const next = reorderBlock(
      projectItems.map((p) => p.id),
      activeId,
      overId,
      block,
    );
    if (!next) return;
    const previous = projectOrder;
    setProjectOrder(next);
    persistReorder(REORDER_PROJECT_CONTAINERS, next, () =>
      setProjectOrder(previous),
    );
  }

  return {
    bulkMoveTo,
    moveSelectionInto,
    bulkDelete,
    moveApp,
    moveFoldersOut,
    moveAppToProject,
    moveAppsToProject,
    reorderAppList,
    reorderFolderList,
    reorderProjectList,
  };
}
