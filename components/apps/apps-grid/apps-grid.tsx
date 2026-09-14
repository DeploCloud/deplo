"use client";

import * as React from "react";
import { useOverviewAppStates } from "./overview-runtime";
import { StaticGrid } from "./static-grid";
import { SortableGrid } from "./sortable-grid";
import type { AppsGridProps, GridProps } from "./grid-contract";

// AppsGrid is the Overview app grid: team-wide drag-to-reorder, folders, and
// drag-into-folder, with every delete hidden optimistically.
export function AppsGrid(props: AppsGridProps) {
  // Deleting is OPTIMISTIC: an app's delete is recorded server-side before its stack
  // comes down, so by the time the mutation answers the app is gone from the product
  // and the card has no reason to still be there.
  const [deleted, setDeleted] = React.useState<ReadonlySet<string>>(new Set());
  const hide = React.useCallback(
    (ids: string[]) => setDeleted((prev) => new Set([...prev, ...ids])),
    [],
  );
  // The other half of hiding on the CLICK: a folder or project the server
  // refuses to delete (and a bulk delete that fails) has to come back, or the
  // card is gone until the next navigation for a delete that never happened.
  const unhide = React.useCallback((ids: string[]) => {
    setDeleted((prev) => {
      if (!ids.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }, []);
  const visibleServices = props.services.filter((p) => !deleted.has(p.id));
  const liveStates = useOverviewAppStates(visibleServices);
  // The parent re-keys the grid whenever the server's answer stops listing them
  // (see `gridKey`), so a successful hide never has to be cleaned up.
  const grid: GridProps = {
    ...props,
    services: visibleServices,
    folders: props.folders.filter((f) => !deleted.has(f.id)),
    projects: props.projects.filter((p) => !deleted.has(p.id)),
    liveStates,
    onDeleted: hide,
    onRestored: unhide,
  };
  if (!props.canReorder && !props.canMoveApps) return <StaticGrid {...grid} />;
  return <SortableGrid {...grid} />;
}
