"use client";

import dynamic from "next/dynamic";

/**
 * The terminal, code-split and client-only. `@xterm/xterm` touches the DOM at
 * construction and ships ~55–80KB gzipped, so it must not enter SSR or the shared
 * bundle — it loads only when a console pane actually mounts. Consumers import
 * `XtermView` from HERE, never from `./xterm-view` directly.
 */
export const XtermView = dynamic(
  () => import("./xterm-view").then((m) => m.XtermView),
  {
    ssr: false,
    loading: () => <div className="h-full w-full bg-[#0a0a0a]" />,
  },
);

// Type-only re-export (erased at build), so importing the API type never pulls
// the emulator into the importing module's bundle.
export type { XtermApi } from "./xterm-view";
