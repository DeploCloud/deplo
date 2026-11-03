"use client";

import { useEffect } from "react";
import { TriangleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { recoverableError, reloadWhenBack } from "@/lib/stale-build";

export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const recoverable = recoverableError(error);

  useEffect(() => {
    if (recoverable) return reloadWhenBack();
    console.error(error);
  }, [error, recoverable]);

  if (recoverable)
    return (
      <div className="flex flex-col items-center justify-center gap-5 rounded-xl border border-dashed border-border py-20 text-center">
        <div className="flex size-12 items-center justify-center rounded-full border border-border bg-secondary">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {recoverable === "stale"
              ? "Deplo was updated"
              : "Connection interrupted"}
          </h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            {recoverable === "stale"
              ? "This tab is still running the previous version. Reloading picks up the new one."
              : "The page stopped loading halfway. Reloading picks it up again."}
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
