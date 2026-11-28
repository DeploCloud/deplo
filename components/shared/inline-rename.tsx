"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import { useOptimisticValue } from "@/components/shared/use-optimistic-value";

/** The name to save, or null when the draft is empty or unchanged. */
export function renamedTo(draft: string, name: string): string | null {
  const next = draft.trim();
  return next && next !== name ? next : null;
}

/** A title that turns into its own field; `mutation` takes `$id` and `$name`. */
export function useInlineRename(
  id: string,
  name: string,
  mutation: string,
  success: string,
) {
  const [editing, setEditing] = React.useState(false);
  const [shown, apply] = useOptimisticValue(name);
  return {
    name: shown,
    editing,
    start: () => setEditing(true),
    done: (next: string | null) => {
      setEditing(false);
      if (next)
        apply(next, () => gqlAction(mutation, { id, name: next }), {
          success,
        });
    },
  };
}

export type InlineRename = ReturnType<typeof useInlineRename>;

// Enter or leaving the field saves, Escape keeps the old name.
export function RenameInput({
  rename,
  label,
  className,
}: {
  rename: InlineRename;
  label: string;
  className?: string;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  const finished = React.useRef(false);
  // A menu item mounts this inside the menu's own commit: focus once its focus trap is gone.
  React.useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => clearTimeout(t);
  }, []);

  function finish(next: string | null) {
    if (finished.current) return;
    finished.current = true;
    rename.done(next);
  }

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <input
      ref={ref}
      defaultValue={rename.name}
      aria-label={label}
      data-card-actions
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onBlur={(e) => finish(renamedTo(e.currentTarget.value, rename.name))}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(renamedTo(e.currentTarget.value, rename.name));
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
      className={cn(
        "pointer-events-auto relative z-10 -mx-[7px] -my-0.5 block h-[calc(1lh+4px)] w-80 max-w-[calc(100%+14px)] min-w-0 rounded-xl border border-input bg-background px-1.5 py-px shadow-sm ring-2 ring-ring ring-offset-1 ring-offset-background outline-none select-text",
        className,
      )}
    />
  );
}
