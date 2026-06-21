"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GripVertical } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ProjectCard } from "./project-card";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { ProjectSummary } from "@/lib/data/projects";

const REORDER_MUTATION = `mutation($ids: [ID!]!) { reorderProjects(projectIds: $ids) }`;

function gridClass(view: "grid" | "list"): string {
  return view === "list" ? "flex flex-col gap-3" : "grid gap-4 sm:grid-cols-2";
}

/**
 * Team-wide drag-to-reorder for the Overview project grid.
 *
 * Reordering writes a team-level order (everyone sees the same arrangement), so
 * it is only enabled for users who may change it — an instance admin or a member
 * with `manage_team` — surfaced via `canReorder`. When that is false (or a search
 * is narrowing the list) the grid renders exactly as before, with no dnd-kit
 * machinery and no drag handles. The reorder is optimistic: the cards move
 * immediately, the new order is persisted via the `reorderProjects` mutation, and
 * a failure reverts the cards and toasts the error.
 */
export function ProjectsGrid({
  projects,
  view,
  canReorder,
}: {
  projects: ProjectSummary[];
  view: "grid" | "list";
  canReorder: boolean;
}) {
  if (!canReorder) {
    return (
      <div className={gridClass(view)}>
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} view={view} />
        ))}
      </div>
    );
  }
  return <SortableGrid projects={projects} view={view} />;
}

function SortableGrid({
  projects,
  view,
}: {
  projects: ProjectSummary[];
  view: "grid" | "list";
}) {
  const router = useRouter();
  // Seeded from the server order. The parent keys this component on that order,
  // so it remounts (re-seeds) whenever the server sends a fresh arrangement;
  // between refreshes the order is owned locally for snappy optimistic moves.
  const [items, setItems] = React.useState(projects);
  const [, startTransition] = React.useTransition();

  const sensors = useSensors(
    // A few px of travel before a drag begins, so clicking the handle (or the
    // card) still registers as a click rather than starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((p) => p.id === active.id);
    const newIndex = items.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const previous = items;
    const next = arrayMove(items, oldIndex, newIndex);
    setItems(next); // optimistic
    startTransition(async () => {
      const res = await gqlAction(REORDER_MUTATION, { ids: next.map((p) => p.id) });
      if (res.ok) {
        router.refresh();
      } else {
        toast.error(res.error);
        setItems(previous); // revert on failure
      }
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={items.map((p) => p.id)}
        strategy={
          view === "list" ? verticalListSortingStrategy : rectSortingStrategy
        }
      >
        <div className={gridClass(view)}>
          {items.map((p) => (
            <SortableProjectCard key={p.id} project={p} view={view} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableProjectCard({
  project,
  view,
}: {
  project: ProjectSummary;
  view: "grid" | "list";
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Dedicated handle (not the whole card) so the card's stretched link still
  // navigates on click; listeners live only here.
  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      aria-label="Drag to reorder"
      className="cursor-grab touch-none rounded-md p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground active:cursor-grabbing"
      onClick={(e) => e.preventDefault()}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4" />
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && "relative z-10 opacity-80 shadow-lg")}
    >
      <ProjectCard project={project} view={view} dragHandle={handle} />
    </div>
  );
}
