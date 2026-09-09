"use client";

import * as React from "react";
import { Sparkles, ArrowRight, X } from "lucide-react";

import Link from "@/components/ui/link";
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
    <div className="flex items-center gap-3 border-b border-border bg-surface-strong px-4 py-2 text-sm sm:px-6">
      <Sparkles className="size-4 shrink-0 text-[var(--success)]" />
      <span className="min-w-0 truncate">
        Deplo <span className="font-medium">{update.latest}</span> is available
        <span className="text-muted-foreground">
          {" "}
          - you have v{update.current}
        </span>
      </span>
      {/* Into the panel, not out to the release page: the command that applies
          the update lives on that tab, and the notes are on it too. */}
      <Link
        href="/settings/deplo?tab=updates"
        className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
      >
        Update
        <ArrowRight className="size-3.5" />
      </Link>
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
