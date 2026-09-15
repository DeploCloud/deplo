"use client";

import * as React from "react";
import { useOverviewAppStates } from "./overview-runtime";
import { StaticGrid } from "./static-grid";
import { SortableGrid } from "./sortable-grid";
import type { AppsGridProps, GridProps } from "./grid-contract";

export function AppsGrid(props: AppsGridProps) {
  const [deleted, setDeleted] = React.useState<ReadonlySet<string>>(new Set());
  const hide = React.useCallback(
    (ids: string[]) => setDeleted((prev) => new Set([...prev, ...ids])),
    [],
  );
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
