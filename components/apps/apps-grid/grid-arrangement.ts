"use client";

import * as React from "react";
import type { FolderCardData } from "../folder-card";
import type { ProjectCardData } from "../project-container-card";
import type { AppSummary } from "@/lib/data/apps/summary";

// useGridArrangement owns the grid's local optimistic order and the projections
// drawn from it: the order arrays are the sole source of arrangement, while the
// card objects always come from props (so status etc. stay fresh).
export function useGridArrangement({
  services,
  allAppIds,
  folders,
  projects,
}: {
  services: AppSummary[];
  allAppIds: string[];
  folders: FolderCardData[];
  projects: ProjectCardData[];
}) {
  const [order, setOrder] = React.useState<string[]>(() => allAppIds);
  const [folderOrder, setFolderOrder] = React.useState<string[]>(() =>
    folders.map((f) => f.id),
  );
  const [projectOrder, setProjectOrder] = React.useState<string[]>(() =>
    projects.map((p) => p.id),
  );
  // Apps AND folders optimistically hidden from the current view while a move (into a
  // folder or a project container) round-trips.
  const [movedIds, setMovedIds] = React.useState<Set<string>>(() => new Set());
  // The card's own move menu drives the same optimistic hide the drag does.
  const hideMoved = React.useCallback(
    (id: string) => setMovedIds((prev) => new Set(prev).add(id)),
    [],
  );
  const revealMoved = React.useCallback((id: string) => {
    setMovedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const byId = React.useMemo(
    () => new Map(services.map((p) => [p.id, p])),
    [services],
  );
  const folderById = React.useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );
  const projectById = React.useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  // Clear optimistic move-hides whenever the visible projection actually changes -
  // the move's refresh landing, or navigating in/out of a folder.
  const sig = [
    ...services.map((p) => `${p.id}:${p.folderId ?? ""}`),
    ...folders.map((f) => `${f.id}:${f.parentId ?? ""}`),
  ].join(",");
  const [prevSig, setPrevSig] = React.useState(sig);
  if (sig !== prevSig) {
    setPrevSig(sig);
    setMovedIds(new Set());
  }

  // The folders to render, in local order, dropping stale ids and appending any
  // the local order hasn't seen yet (a freshly created folder). Anything
  // optimistically moved into a project is hidden until its refresh lands.
  const folderItems = React.useMemo(() => {
    const ordered = folderOrder
      .map((id) => folderById.get(id))
      .filter((f): f is FolderCardData => f != null && !movedIds.has(f.id));
    const known = new Set(folderOrder);
    return [
      ...ordered,
      ...folders.filter((f) => !known.has(f.id) && !movedIds.has(f.id)),
    ];
  }, [folderOrder, folderById, folders, movedIds]);

  const folderIdSet = React.useMemo(
    () => new Set(folderItems.map((f) => f.id)),
    [folderItems],
  );

  // Project container cards, in local order (same contract as folderItems).
  const projectItems = React.useMemo(() => {
    const ordered = projectOrder
      .map((id) => projectById.get(id))
      .filter((p): p is ProjectCardData => p != null);
    const known = new Set(projectOrder);
    return [...ordered, ...projects.filter((p) => !known.has(p.id))];
  }, [projectOrder, projectById, projects]);

  const projectIdSet = React.useMemo(
    () => new Set(projectItems.map((p) => p.id)),
    [projectItems],
  );

  // The visible apps, in the full local order, filtered to the displayed
  // group (everything in `byId`) minus anything optimistically moved away.
  const items = React.useMemo(() => {
    const ordered = order
      .map((id) => byId.get(id))
      .filter((p): p is AppSummary => p != null && !movedIds.has(p.id));
    const known = new Set(order);
    return [
      ...ordered,
      ...services.filter((p) => !known.has(p.id) && !movedIds.has(p.id)),
    ];
  }, [order, byId, services, movedIds]);

  return {
    order,
    setOrder,
    folderOrder,
    setFolderOrder,
    projectOrder,
    setProjectOrder,
    setMovedIds,
    hideMoved,
    revealMoved,
    byId,
    folderById,
    projectById,
    items,
    folderItems,
    folderIdSet,
    projectItems,
    projectIdSet,
  };
}

export type GridArrangement = ReturnType<typeof useGridArrangement>;
