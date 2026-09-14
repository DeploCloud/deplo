"use client";

import * as React from "react";
import { GripVertical } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeListenersToSubtree } from "@/lib/portal-event-scope";
import { cn } from "@/lib/utils";

// SortableItem wraps every card: the dnd-kit sortable node, a keyboard drag
// handle, the drag-bound jiggle, and the click dnd-kit emits after a drop.
export function SortableItem({
  id,
  dragging,
  scaleOut = false,
  selected = false,
  groupDragging = false,
  locked = false,
  dataKind,
  onSelect,
  children,
}: {
  id: string;
  dragging: boolean;
  /** When this item is the one being dragged, shrink it to nothing (smoothly) -
   *  used to preview an app being absorbed into the folder it hovers. */
  scaleOut?: boolean;
  /** Whether this card is part of the current multi-selection (shows a ring). */
  selected?: boolean;
  /** This card travels with the lifted one (multi-selection drag), so dim it too. */
  groupDragging?: boolean;
  /** A migration is still writing this row: no drag, no modifier-select. */
  locked?: boolean;
  /** "project" | "folder" | "service" - surfaced as data-card-kind for marquee
   *  hit-testing. */
  dataKind?: string;
  /** Modifier-click (ctrl/cmd/shift) selection handler. */
  onSelect?: (e: React.MouseEvent) => void;
  children: (opts: {
    handle: React.ReactNode;
    dragActive: boolean;
    isOver: boolean;
  }) => React.ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
    index,
  } = useSortable({ id, disabled: locked });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Split listeners by input: pointer activators (Mouse/Touch) drive the whole-
  // card drag from the wrapper; the keyboard activator lives on the handle so
  // the card keeps clean link semantics rather than becoming a focusable button.
  const { onKeyDown: keyboardListener, ...rawPointerDragListeners } =
    listeners ?? {};
  // A press inside a menu or modal THIS card rendered still reaches these
  // listeners through the React tree (portals move the DOM node, not the React
  // parent), and must never pick the card up under the backdrop.
  const pointerDragListeners = scopeListenersToSubtree(rawPointerDragListeners);
  // Drop the draggable's role="button" (and its role-only ARIA companions) from
  // the wrapper: it also hosts the menu button, and a button must not nest one.
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    role: _omitRole,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    "aria-roledescription": _omitRoleDesc,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    "aria-pressed": _omitPressed,
    ...wrapperAttributes
  } = attributes;

  // Belt-and-suspenders for the trailing click after a drag: dnd-kit already stops
  // that click at the document level, but if it slips through we swallow it so a
  // drag never navigates.
  const draggedRef = React.useRef(false);
  React.useEffect(() => {
    if (isDragging) {
      draggedRef.current = true;
      return;
    }
    // Keep the latch just long enough to cover the trailing click, then clear it
    // so later real clicks are never mistaken for it.
    const t = window.setTimeout(() => {
      draggedRef.current = false;
    }, 300);
    return () => window.clearTimeout(t);
  }, [isDragging]);

  function onClickCapture(e: React.MouseEvent<HTMLDivElement>) {
    // Menus and modals this card opens are portalled to <body> but stay REACT children
    // of it, so their clicks arrive here first (capture runs before the event ever
    // reaches the surface, so the surface cannot stop it - see lib/portal-event-scope.ts).
    if (!e.currentTarget.contains(e.target as Node)) return;
    const onControls = Boolean(
      (e.target as HTMLElement).closest?.("[data-card-actions]"),
    );
    if (draggedRef.current) {
      draggedRef.current = false;
      if (onControls) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Modifier-click selects this card instead of navigating (spare the controls).
    if (
      (e.metaKey || e.ctrlKey || e.shiftKey) &&
      onSelect &&
      !locked &&
      !onControls
    ) {
      e.preventDefault();
      e.stopPropagation();
      onSelect(e);
    }
  }

  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      aria-label="Drag to move or reorder"
      className="cursor-grab rounded-md p-1 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 active:cursor-grabbing"
      onClick={(e) => e.preventDefault()}
      onKeyDown={keyboardListener as React.KeyboardEventHandler}
      {...attributes}
    >
      <GripVertical className="size-4" />
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-card-id={id}
      data-card-kind={dataKind}
      onClickCapture={onClickCapture}
      className={cn(
        // Suppress the native long-press callout / text selection so a touch
        // drag isn't preempted by the browser's own link/selection UI.
        "touch-manipulation rounded-xl select-none [-webkit-touch-callout:none]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        // Only the stacking lives on the outer node - the translate dnd-kit
        // writes here must stay instant so the card tracks the pointer.
        isDragging && "relative z-10",
      )}
      {...wrapperAttributes}
      {...pointerDragListeners}
    >
      <div
        className={cn(
          "rounded-xl",
          dragging && !isDragging && "animate-jiggle",
          isDragging && "opacity-40 transition-transform duration-200 ease-out",
          !isDragging &&
            groupDragging &&
            "opacity-40 transition-opacity duration-150",
          // Hovering a folder: the placeholder slot collapses to nothing as the
          // floating clone is absorbed; it grows back the moment it leaves.
          isDragging && scaleOut && "scale-0",
        )}
        style={
          dragging && !isDragging
            ? { animationDelay: `${-((index ?? 0) % 6) * 40}ms` }
            : undefined
        }
      >
        {children({ handle, dragActive: dragging, isOver })}
      </div>
    </div>
  );
}
