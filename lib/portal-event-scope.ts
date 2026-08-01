import type * as React from "react";

/**
 * A React portal moves the DOM node; it does NOT move the React parent. Events
 * from a portalled surface (Dialog, Sheet, DropdownMenu, Popover, Select …)
 * still travel the REACT tree — so a modal opened from an app card's ⋯ menu,
 * which that card renders, delivers every press on its backdrop AND on its own
 * body to the card, exactly as if the user had pressed the card itself.
 *
 * Nothing in the DOM hints at it: the overlay covers the page and `<body>` is
 * `pointer-events: none`, so hit-testing is innocent — but dnd-kit's sensors,
 * which listen on the card wrapper, pick the card up and drag it under the
 * backdrop, and dnd-kit's floating clone (z-index 999) then paints over the
 * modal. The Overview's marquee starts the same way.
 *
 * Fix: every handler that STARTS a gesture is scoped to its own DOM subtree —
 * this module for listener maps we don't own (dnd-kit's activators), and a plain
 * `e.currentTarget.contains(e.target)` guard for the handlers we do write (the
 * card wrappers' `onClickCapture`, the marquee's `onCanvasPointerDown`).
 *
 * The tempting alternative — `stopPropagation()` on the surface itself, sealing
 * it once for every consumer — is NOT available: React's `stopPropagation` also
 * stops the underlying native event, React listens at the root container, and
 * Radix detects outside-presses from a listener on `document`, further out. A
 * sealed surface therefore never dismisses on a backdrop click. Verified, not
 * theorized: it wedged every modal in the app shut.
 */

/**
 * Wraps a listener map so each handler only runs for events that started inside
 * the element the map is spread on. An event that merely passed through the
 * React tree from a portalled surface can no longer start the gesture, whatever
 * rendered that surface. Propagation itself is untouched, so Radix's dismiss and
 * focus handling (native, on `document`) behave exactly as before.
 *
 * Non-function entries are passed through unchanged.
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
