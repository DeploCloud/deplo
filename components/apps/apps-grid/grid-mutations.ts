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
const BULK_MOVE = `mutation($ids: [ID!]!, $folderId: ID) { moveAppsToFolder(appIds: $ids, folderId: $folderId) }`;
const BULK_DELETE = `mutation($ids: [ID!]!) { deleteApps(ids: $ids) }`;

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
    onDeleted(all);
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
        setMovedIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }
      router.refresh();
    });
  }

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
