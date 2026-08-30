"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Sparkles, ArrowUpRight, X } from "lucide-react";

import { useUpstreamUpdate } from "./update-state";

const DISMISS_KEY = "deplo:update-dismissed";

/**
 * Thin banner shown across the dashboard when a newer Deplo release exists
 * upstream. Dismissal is remembered per version, so it reappears only when a
 * still-newer release lands.
 */
export function UpdateBanner() {
  const update = useUpstreamUpdate();
  const [dismissed, setDismissed] = React.useState<string | null>(null);

  React.useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(window.localStorage.getItem(DISMISS_KEY) ?? "");
    } catch {
      /* private mode, blocked storage - the banner simply shows */
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed("");
    }
  }, []);

  // `null` is "not read yet": rendering the banner before the stored answer is in
  // would flash a notice the user closed on the last page.
  if (!update || dismissed === null || dismissed === update.latest) return null;

  function dismiss() {
    if (!update) return;
    try {
      window.localStorage.setItem(DISMISS_KEY, update.latest);
    } catch {
      /* ignore */
    }
    setDismissed(update.latest);
  }

  return (
    <div className="flex items-center gap-3 border-b border-border bg-secondary/50 px-4 py-2 text-sm sm:px-6">
      <Sparkles className="size-4 shrink-0 text-[var(--success)]" />
      <span className="min-w-0 truncate">
        Deplo <span className="font-medium">{update.latest}</span> is available
        <span className="text-muted-foreground">
          {" "}
          - you have v{update.current}
        </span>
      </span>
      <a
        href={update.url ?? "#"}
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
