"use client";

import * as React from "react";

/**
 * Guards a modal Dialog/Sheet against being dismissed by the *same* pointer
 * gesture that dismisses a Radix popper layer nested inside it (a Select,
 * DropdownMenu, Popover, …).
 *
 * The bug: a nested Select/menu closes on `pointerdown`, but the modal defers
 * its own outside-dismiss to the following `click` (Radix sets
 * `deferPointerDownOutside`). By click-time the inner layer has already
 * unmounted, so the modal — top of the layer stack again — reads the same press
 * as an outside click and closes too. Pressing anywhere off the open popup
 * triggers it, because while the popup is open Radix marks the modal content
 * `pointer-events: none`, so even a press over the modal body lands on the
 * overlay. (Escape is immune: it is routed only to the top-most layer.)
 * See https://github.com/radix-ui/primitives/issues/2961.
 *
 * Fix: at `pointerdown` (capture phase, before the popper closes) note whether a
 * dismissible popper layer was open. If it was, the interaction that follows was
 * meant to close THAT layer — the caller should `preventDefault()` the modal's
 * one outside-dismiss. A later press with nothing open closes the modal as
 * normal.
 *
 * Returns a ref whose `.current` is `true` when a dismissible popper was open at
 * the most recent pointerdown. Read it inside the content's `onInteractOutside`.
 */
export function useNestedLayerDismissGuard() {
  const nestedLayerWasOpenRef = React.useRef(false);
  React.useEffect(() => {
    const onPointerDown = () => {
      nestedLayerWasOpenRef.current = Array.from(
        document.querySelectorAll("[data-radix-popper-content-wrapper]")
      ).some((wrapper) => {
        const content = wrapper.firstElementChild;
        // Tooltips/hover-cards share the popper wrapper but aren't dismissible
        // interactive layers, so a stray one can't wedge the modal open.
        return (
          content?.getAttribute("data-state") === "open" &&
          content.getAttribute("role") !== "tooltip"
        );
      });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
  return nestedLayerWasOpenRef;
}
