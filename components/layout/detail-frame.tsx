"use client";

import { useFullBleedRoute } from "@/components/layout/shell-frame";

/**
 * The body of an app's or a database's section pages.
 *
 * Normally that is a readable 72rem column with a header above it — the name,
 * the live status, the URL, and the controls (Visit, Stop, Reload, Redeploy).
 * On a full-bleed route the header and the measure both come off: those buttons
 * are exactly the "app controls above the logs" the full-screen log pane exists
 * to get rid of, and a pane inside a centred column is not full-screen however
 * far the shell opened up for it.
 *
 * `sidecars` is whatever must render either way and draws nothing — the nav
 * publisher that puts the app's sub-menu in the sidebar, the live-status seed.
 * Dropping those with the header would take the section menu away with it.
 */
export function DetailFrame({
  header,
  sidecars,
  children,
}: {
  header: React.ReactNode;
  sidecars?: React.ReactNode;
  children: React.ReactNode;
}) {
  const full = useFullBleedRoute();

  if (full) {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        {sidecars}
        {children}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {header}
      {sidecars}
      {children}
    </div>
  );
}
