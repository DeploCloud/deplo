"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GripVertical } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
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
  // Only the order (a list of ids) is owned locally, for snappy optimistic
  // moves; the card objects themselves always come from the latest server props
  // (see `items` below), so per-card fields like status stay fresh. The parent
  // keys this component on the *membership* of the grid (the set of ids, not
  // their order), so reordering never remounts it — that lets the jiggle/edit
  // mode survive a drop — while adding/removing a project still re-seeds.
  // Trade-off: because membership-stable means no remount, a reorder made by
  // *another* team member won't reflect here until membership changes or a hard
  // reload (this client's local order intentionally wins between reorders).
  const [order, setOrder] = React.useState<string[]>(() =>
    projects.map((p) => p.id),
  );
  // iOS-style reorder ("jiggle") mode: entered by dragging a card (auto), or
  // without moving by a ~half-second touch hold / a 2s mouse hold. A drag clears
  // it on release (onDragEnd/onDragCancel); a no-drag hold is dismissed by
  // Escape or a press outside. There is intentionally no toolbar — the gesture
  // settles the cards on its own.
  const [editMode, setEditMode] = React.useState(false);
  const [, startTransition] = React.useTransition();
  const rootRef = React.useRef<HTMLDivElement>(null);

  // Derived render list: the local order applied to the current server objects.
  // This is the sole source of order and freshness — projects that vanished drop
  // out, newcomers are appended, and per-card fields track the latest props.
  const items = React.useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const ordered = order
      .map((id) => byId.get(id))
      .filter((p): p is ProjectSummary => p != null);
    const known = new Set(order);
    return [...ordered, ...projects.filter((p) => !known.has(p.id))];
  }, [order, projects]);

  // While in edit mode, Escape or a press outside the editing UI leaves it. The
  // press check spares the whole editing surface (toolbar + grid, via rootRef)
  // and the dropdown menu, which Radix portals outside it.
  React.useEffect(() => {
    if (!editMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setEditMode(false);
    }
    function onDown(e: PointerEvent) {
      const t = e.target as HTMLElement | null;
      if (rootRef.current?.contains(t)) return;
      if (
        t?.closest?.(
          '[data-radix-popper-content-wrapper],[role="menu"],[role="menuitem"]',
        )
      )
        return;
      setEditMode(false);
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [editMode]);

  const sensors = useSensors(
    // Mouse: a few px of travel before a drag begins, so a click still navigates
    // rather than starting a reorder.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // Touch: a deliberate ~half-second hold (the iOS long-press feel) before a
    // drag begins, so a tap navigates, a brief rest-then-swipe still scrolls the
    // page, and only an intentional "hold and drag" reorders. dnd-kit's delay
    // constraint activates on the timer alone, so this also doubles as the touch
    // "hold to enter edit mode" — holding without moving enters jiggle mode.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 500, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Any drag — from the card body, the handle, or the keyboard — flips the grid
  // into edit mode (the cards jiggle) so it reads as a reorder rather than a
  // navigation. There is no toolbar: releasing settles the cards (onDragEnd /
  // onDragCancel turn edit mode back off), so the gesture is self-explanatory.
  function onDragStart() {
    setEditMode(true);
  }

  function onDragEnd(event: DragEndEvent) {
    setEditMode(false); // release → the cards settle into place
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((p) => p.id === active.id);
    const newIndex = items.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const previousOrder = order;
    const nextIds = arrayMove(items, oldIndex, newIndex).map((p) => p.id);
    setOrder(nextIds); // optimistic
    startTransition(async () => {
      const res = await gqlAction(REORDER_MUTATION, { ids: nextIds });
      if (res.ok) {
        router.refresh();
      } else {
        toast.error(res.error);
        setOrder(previousOrder); // revert on failure
      }
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setEditMode(false)}
    >
      <div ref={rootRef}>
        <SortableContext
          items={items.map((p) => p.id)}
          strategy={
            view === "list" ? verticalListSortingStrategy : rectSortingStrategy
          }
        >
          <div className={gridClass(view)}>
            {items.map((p) => (
              <SortableProjectCard
                key={p.id}
                project={p}
                view={view}
                editMode={editMode}
                onEnterEditMode={() => setEditMode(true)}
              />
            ))}
          </div>
        </SortableContext>
      </div>
    </DndContext>
  );
}

function SortableProjectCard({
  project,
  view,
  editMode,
  onEnterEditMode,
}: {
  project: ProjectSummary;
  view: "grid" | "list";
  editMode: boolean;
  onEnterEditMode: () => void;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    index,
  } = useSortable({ id: project.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // dnd-kit's listeners split by input: the pointer activators (Mouse/Touch)
  // drive the whole-card drag and live on the wrapper; the keyboard activator
  // lives on the dedicated handle (out of edit mode) so the card keeps clean
  // link semantics instead of becoming a focusable button.
  const { onKeyDown: keyboardListener, ...pointerDragListeners } =
    listeners ?? {};
  // Drop the draggable's default role="button" on the wrapper: in edit mode the
  // wrapper also hosts the ⋯ menu button, and a button must not nest one. The
  // role-dependent ARIA companions (`aria-roledescription`, `aria-pressed`) go
  // with it — they are invalid on the resulting roleless (generic) element.
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    role: _omitRole,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    "aria-roledescription": _omitRoleDesc,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    "aria-pressed": _omitPressed,
    ...wrapperAttributes
  } = attributes;

  // Mouse-only secondary entry to edit mode: a still 2s hold. Touch has no need
  // for it — its TouchSensor delay already enters edit mode on a ~half-second
  // hold — and a stationary mouse press never trips the distance-based
  // MouseSensor, so this is the only no-drag entry on a pointer. Movement,
  // release, a context menu, or a cancel aborts the pending hold.
  const timerRef = React.useRef<number | null>(null);
  const firedRef = React.useRef(false);
  const startRef = React.useRef<{ x: number; y: number } | null>(null);

  React.useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  function clearLongPress() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }

  // Entering edit mode (by drag or hold) cancels any pending hold timer so it
  // can't fire a redundant onEnterEditMode mid-drag.
  React.useEffect(() => {
    if (editMode) clearLongPress();
  }, [editMode]);

  // Bubbling-phase handlers: a press the controls (`data-card-actions`)
  // stopPropagation on never reaches the card, so the menu doesn't arm the hold.
  // Inactive once already in edit mode.
  const longPressHandlers: React.HTMLAttributes<HTMLDivElement> = editMode
    ? {}
    : {
        onPointerDown: (e) => {
          // Left mouse button only: touch/pen enter edit mode via the TouchSensor
          // hold, so arming a second timer for them would just race that.
          if (e.pointerType !== "mouse" || e.button !== 0) return;
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          firedRef.current = false;
          startRef.current = { x: e.clientX, y: e.clientY };
          timerRef.current = window.setTimeout(() => {
            firedRef.current = true;
            onEnterEditMode();
          }, 2000);
        },
        onPointerMove: (e) => {
          const s = startRef.current;
          if (!s) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          if (dx * dx + dy * dy > 100) clearLongPress();
        },
        onPointerUp: clearLongPress,
        onPointerLeave: clearLongPress,
        onPointerCancel: clearLongPress,
        onContextMenu: clearLongPress,
      };

  // Swallow the click that a drag or hold would otherwise leave behind, and
  // every click while reordering, so the card never navigates mid-edit. The
  // controls are exempt so the ⋯ menu keeps working in edit mode.
  function onClickCapture(e: React.MouseEvent<HTMLDivElement>) {
    if (!editMode && !firedRef.current) return;
    if ((e.target as HTMLElement).closest?.("[data-card-actions]")) return;
    e.preventDefault();
    e.stopPropagation();
    firedRef.current = false;
  }

  // Dedicated, keyboard-only drag activator, revealed on hover/focus. Pointer
  // drags happen on the whole card (wrapper), so this carries the keyboard
  // listener only. Dropped in edit mode, where the whole card is the activator.
  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      aria-label="Drag to reorder"
      className="cursor-grab rounded-md p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
      onClick={(e) => e.preventDefault()}
      onKeyDown={keyboardListener as React.KeyboardEventHandler}
      {...attributes}
    >
      <GripVertical className="size-4" />
    </button>
  );

  // In edit mode the wrapper is both the sortable node and its activator.
  const setWrapperRef = (node: HTMLDivElement | null) => {
    setNodeRef(node);
    if (editMode) setActivatorNodeRef(node);
  };
  // Out of edit mode the whole card is draggable by pointer (Mouse/Touch) and a
  // still-hold arms edit mode. In edit mode it gains the full activator props
  // (incl. keyboard) and the inert link lets it be dragged from anywhere.
  const activatorProps = editMode
    ? { ...wrapperAttributes, ...listeners }
    : { ...pointerDragListeners, ...longPressHandlers };

  return (
    <div
      ref={setWrapperRef}
      style={style}
      onClickCapture={onClickCapture}
      className={cn(
        // Suppress the native long-press callout / text selection so a hold or a
        // touch-drag isn't preempted by the browser's own link/selection UI.
        "touch-manipulation select-none rounded-xl [-webkit-touch-callout:none]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        isDragging && "relative z-10 opacity-80 shadow-lg",
      )}
      {...activatorProps}
    >
      {/* Inner wrapper carries the jiggle so it never fights the translate
          transform dnd-kit writes on the sortable node above. */}
      <div
        className={cn(editMode && !isDragging && "animate-jiggle")}
        style={
          editMode
            ? { animationDelay: `${-((index ?? 0) % 6) * 40}ms` }
            : undefined
        }
      >
        <ProjectCard
          project={project}
          view={view}
          editMode={editMode}
          dragHandle={editMode ? null : handle}
        />
      </div>
    </div>
  );
}
