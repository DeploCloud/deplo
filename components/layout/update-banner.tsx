"use client";

import * as React from "react";
import { Sparkles, ArrowUpRight, X } from "lucide-react";
import { gqlAction } from "@/lib/graphql-client";
import type { UpdateInfo } from "@/lib/data/updates";

const DISMISS_KEY = "deplo:update-dismissed";

/**
 * Thin banner shown across the dashboard when a newer Deplo release exists
 * upstream. Dismissal is remembered per version, so it reappears only when a
 * still-newer release lands.
 */
export function UpdateBanner() {
  const [info, setInfo] = React.useState<UpdateInfo | null>(null);

  React.useEffect(() => {
    let active = true;
    gqlAction<{ updateInfo: UpdateInfo | null }, UpdateInfo | null>(
      `query { updateInfo { updateAvailable latest current url } }`,
      undefined,
      (d) => d.updateInfo,
    ).then((res) => {
      if (!active || !res.ok || !res.data) return;
      const d = res.data;
      if (!d.updateAvailable || !d.latest) return;
      let dismissed = "";
      try {
        dismissed = window.localStorage.getItem(DISMISS_KEY) ?? "";
      } catch {
        /* ignore */
      }
      if (dismissed === d.latest) return;
      setInfo(d);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!info?.updateAvailable) return null;

  function dismiss() {
    try {
      if (info?.latest) window.localStorage.setItem(DISMISS_KEY, info.latest);
    } catch {
      /* ignore */
    }
    setInfo(null);
  }

  return (
    <div className="flex items-center gap-3 border-b border-border bg-secondary/50 px-4 py-2 text-sm sm:px-6">
      <Sparkles className="size-4 shrink-0 text-[var(--success)]" />
      <span className="min-w-0 truncate">
        Deplo <span className="font-medium">{info.latest}</span> is available
        <span className="text-muted-foreground"> — you have v{info.current}</span>
      </span>
      <a
        href={info.url ?? "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
      >
        View release
        <ArrowUpRight className="size-3.5" />
      </a>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss update notice"
        className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
