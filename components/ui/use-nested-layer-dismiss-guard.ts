"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

/**
 * Guards a modal Dialog/Sheet against being dismissed by the *same* pointer
 * gesture that dismisses a Radix popper layer nested inside it (a Select,
 * DropdownMenu, Popover, …).
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
          !content.isConnected || content.getAttribute("data-state") !== "open",
      ),
    [],
  );
}

function openPopperContents(): Element[] {
  return Array.from(
    document.querySelectorAll("[data-radix-popper-content-wrapper]"),
  )
    .map((wrapper) => wrapper.firstElementChild)
    .filter(
      (content): content is Element =>
        content?.getAttribute("data-state") === "open",
    );
}
