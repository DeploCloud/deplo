"use client";

import { Loader2 } from "lucide-react";
import { useFullBleedRoute } from "@/components/layout/shell-frame";

/**
 * The body of an app's or a database's section pages. `sidecars` is whatever must
 * render either way and draws nothing - the nav publisher that puts the app's
 * sub-menu in the sidebar, the live-status seed.
 */
export function DetailFrame({
  header,
  sidecars,
  locked = false,
  children,
}: {
  header: React.ReactNode;
  sidecars?: React.ReactNode;
  /** A migration is still writing this app or database: the whole page renders
   *  inert, so nothing here can be pressed while the run owns the row. */
  locked?: boolean;
  children: React.ReactNode;
}) {
  const full = useFullBleedRoute();

  if (full) {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        {sidecars}
        {locked ? (
          <div inert className="flex min-h-0 flex-1 flex-col opacity-70">
            {children}
          </div>
        ) : (
          children
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {sidecars}
      {locked ? (
        <>
          <MigrationNotice />
          <div inert className="space-y-6 opacity-70">
            {header}
            {children}
          </div>
        </>
      ) : (
        <>
          {header}
          {children}
        </>
      )}
    </div>
  );
}

/** Why the page below it does nothing. */
function MigrationNotice() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
      <div>
        <p className="font-medium">Still being brought over by a migration</p>
        <p className="mt-1 text-muted-foreground">
          Nothing here can be changed until the run finishes, in Settings →
          Migrations.
        </p>
      </div>
    </div>
  );
}
