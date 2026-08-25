"use client";

import { useEffect } from "react";
import { TriangleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isStaleBuildError, reloadOnce } from "@/lib/stale-build";

export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  // `retry` re-fetches and re-renders the children, including the Server Components
  // that failed.
  retry: () => void;
}) {
  // A tab left open across a deplo update asks for chunk files that build
  // replaced. Nothing is wrong with the page - reloading renders it.
  const stale = isStaleBuildError(error);

  useEffect(() => {
    if (stale) {
      reloadOnce();
      return;
    }
    // Surface to the server logs; do not expose internals to the UI.
    console.error(error);
  }, [error, stale]);

  // The reload is automatic; the button is what is left when the cooldown
  // suppressed it (a second stale error moments after the first).
  if (stale)
    return (
      <div className="flex flex-col items-center justify-center gap-5 rounded-xl border border-dashed border-border py-20 text-center">
        <div className="flex size-12 items-center justify-center rounded-full border border-border bg-secondary">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Deplo was updated</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            This tab is still running the previous version. Reloading picks up
            the new one.
          </p>
        </div>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );

  return (
    <div className="flex flex-col items-center justify-center gap-5 rounded-xl border border-dashed border-border py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-border bg-secondary">
        <TriangleAlert className="size-5 text-[var(--warning)]" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          An unexpected error occurred while rendering this page.
        </p>
      </div>
      <Button onClick={() => retry()}>Try again</Button>
    </div>
  );
}
