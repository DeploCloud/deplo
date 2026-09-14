"use client";

import * as React from "react";

// useNestedLayerDismissGuard guards a modal Dialog/Sheet against the same pointer gesture that dismisses a Radix popper nested inside it.
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
