"use client";

import * as React from "react";
import { GripVertical } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeListenersToSubtree } from "@/lib/portal-event-scope";
import { cn } from "@/lib/utils";

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
  scaleOut?: boolean;
  selected?: boolean;
  groupDragging?: boolean;
  locked?: boolean;
  dataKind?: string;
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

  const { onKeyDown: keyboardListener, ...rawPointerDragListeners } =
    listeners ?? {};
  const pointerDragListeners = scopeListenersToSubtree(rawPointerDragListeners);
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    role: _omitRole,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    "aria-roledescription": _omitRoleDesc,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    "aria-pressed": _omitPressed,
    ...wrapperAttributes
  } = attributes;

  const draggedRef = React.useRef(false);
  React.useEffect(() => {
    if (isDragging) {
      draggedRef.current = true;
      return;
    }
    const t = window.setTimeout(() => {
      draggedRef.current = false;
    }, 300);
    return () => window.clearTimeout(t);
  }, [isDragging]);

  function onClickCapture(e: React.MouseEvent<HTMLDivElement>) {
    // Portals move the DOM node, not the React parent, so a portalled menu clicks through here.
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
        "touch-manipulation rounded-xl select-none [-webkit-touch-callout:none]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        isDragging && "relative z-10",
      )}
      {...wrapperAttributes}
      {...pointerDragListeners}
    >
      <div
        className={cn(
          // The jiggle rests at ±0.55deg, so without a transition every card
          // snaps back the instant a drop ends it.
          "rounded-xl transition-transform duration-200 ease-out",
          dragging && !isDragging && "animate-jiggle",
          isDragging && "opacity-40",
          !isDragging &&
            groupDragging &&
            "opacity-40 transition-opacity duration-150",
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
