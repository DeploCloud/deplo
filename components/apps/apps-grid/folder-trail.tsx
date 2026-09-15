"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { ChevronLeft } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { folderHref } from "../folder-card";
import { cn } from "@/lib/utils";
import type { FolderRef, TrailSeg } from "./grid-contract";

export const UNGROUP_DROP_ID = "__ungroup__";

function allAppsHref(view: "grid" | "list"): string {
  return view === "list" ? "/?view=list" : "/";
}

export function FolderTrail({
  path,
  view,
}: {
  path: TrailSeg[];
  view: "grid" | "list";
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <Link
        href={allAppsHref(view)}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Overview
      </Link>
      {path.map((seg, i) => {
        const last = i === path.length - 1;
        return (
          <React.Fragment key={seg.id}>
            <span className="text-muted-foreground/50">/</span>
            {last ? (
              <span className="font-medium">{seg.name}</span>
            ) : (
              <Link
                href={seg.href ?? folderHref(seg.id, view)}
                className="text-muted-foreground hover:text-foreground"
              >
                {seg.name}
              </Link>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function DroppableBreadcrumb({
  path,
  view,
  dragging,
}: {
  path: FolderRef[];
  view: "grid" | "list";
  dragging: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: UNGROUP_DROP_ID });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md px-1 py-1 transition-colors",
        dragging && "ring-dashed ring-1 ring-border",
        isOver && "bg-primary-wash-strong ring-1 ring-primary/40",
      )}
    >
      <FolderTrail path={path} view={view} />
      {dragging && (
        <span className="ml-1 text-xs text-muted-foreground">
          {isOver ? "Release to move out a level" : "drop here to move out"}
        </span>
      )}
    </div>
  );
}
