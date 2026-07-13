"use client";

import * as React from "react";

/**
 * Guards a modal Dialog/Sheet against being dismissed by the *same* pointer
 * gesture that dismisses a Radix popper layer nested inside it (a Select,
 * DropdownMenu, Popover, …).
 *
 * The bug: DialogContent's dismissable layer sets `deferPointerDownOutside`, so
 * a primary-button press outside defers the modal's own dismiss to the following
 * `click`. A nested Select/menu, which does NOT defer, closes at `pointerdown`
 * and unmounts. By click-time the modal is top of the layer stack again, so it
 * reads the same press as an outside click and closes too. Pressing anywhere off
 * the open popup triggers it, because while the popup is open Radix marks the
 * modal content `pointer-events: none`, so even a press over the modal body
 * lands on the overlay. (Escape is immune: it is routed only to the top-most
 * layer.) See https://github.com/radix-ui/primitives/issues/2961.
 *
 * Fix: at `pointerdown` (capture phase, before any popper closes) snapshot the
 * poppers that are open. The modal then swallows its one outside-dismiss only if
 * one of those poppers actually CLOSED — i.e. the gesture was spent dismissing
 * it. That "actually closed" test is the whole point: a popper that stays open
 * did not consume the press, so the modal must dismiss as normal. Checking
 * merely that *some* popper was open would wedge every modal open behind any
 * lingering one — notably a DropdownMenu whose item called `preventDefault()` in
 * `onSelect`, which keeps the menu mounted and open underneath the modal it just
 * opened, where it can never dismiss itself (it sits below the modal's
 * outside-pointer-events-disabling layer).
 *
 * Returns a predicate to call from the content's `onInteractOutside`.
 *
 * Tooltips need no special-casing: Radix renders them `data-state="delayed-open"`
 * / `"instant-open"`, never `"open"`, so they never enter the snapshot.
 */
export function useNestedLayerDismissGuard() {
  const openAtPointerDownRef = React.useRef<Element[]>([]);

  React.useEffect(() => {
    const onPointerDown = () => {
      openAtPointerDownRef.current = openPopperContents();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  return React.useCallback(
    () =>
      openAtPointerDownRef.current.some(
        (content) =>
          // Unmounted outright, or still mounted for an exit animation.
          !content.isConnected ||
          content.getAttribute("data-state") !== "open"
      ),
    []
  );
}

function openPopperContents(): Element[] {
  return Array.from(
    document.querySelectorAll("[data-radix-popper-content-wrapper]")
  )
    .map((wrapper) => wrapper.firstElementChild)
    .filter(
      (content): content is Element =>
        content?.getAttribute("data-state") === "open"
    );
}
