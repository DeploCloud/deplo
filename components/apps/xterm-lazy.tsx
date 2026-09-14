"use client";

import dynamic from "next/dynamic";

// XtermView - `@xterm/xterm` touches the DOM at construction, so it must never enter SSR.
export const XtermView = dynamic(
  () => import("./xterm-view").then((m) => m.XtermView),
  {
    ssr: false,
    loading: () => <div className="h-full w-full bg-terminal" />,
  },
);

// Type-only so importing the API type never pulls the emulator into the importer's bundle.
export type { XtermApi } from "./xterm-view";
