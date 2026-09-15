"use client";

import dynamic from "next/dynamic";

export const XtermView = dynamic(
  () => import("./xterm-view").then((m) => m.XtermView),
  {
    ssr: false,
    loading: () => <div className="h-full w-full bg-terminal" />,
  },
);

export type { XtermApi } from "./xterm-view";
