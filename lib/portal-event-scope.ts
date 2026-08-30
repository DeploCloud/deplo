import type * as React from "react";

/**
 * A React portal moves the DOM node; it does NOT move the React parent. A sealed
 * surface therefore never dismisses on a backdrop click.
 */

/**
 * Wraps a listener map so each handler only runs for events that started inside
 * the element the map is spread on. Propagation itself is untouched, so Radix's
 * dismiss and focus handling (native, on `document`) behave exactly as before.
 */
export function scopeListenersToSubtree<L extends object>(listeners: L): L {
  const scoped: Record<string, unknown> = {
    ...(listeners as Record<string, unknown>),
  };
  for (const [name, handler] of Object.entries(scoped)) {
    if (typeof handler !== "function") continue;
    const call = handler as (event: React.SyntheticEvent) => void;
    scoped[name] = (event: React.SyntheticEvent) => {
      const node = event.currentTarget as Node | null;
      if (node && !node.contains(event.target as Node)) return;
      call(event);
    };
  }
  return scoped as L;
}
