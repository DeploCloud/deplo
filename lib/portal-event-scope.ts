import type * as React from "react";

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
