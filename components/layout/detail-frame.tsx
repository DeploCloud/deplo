"use client";

import { useFullBleedRoute } from "@/components/layout/shell-frame";

/**
 * The body of an app's or a database's section pages. `sidecars` is whatever must
 * render either way and draws nothing - the nav publisher that puts the app's
 * sub-menu in the sidebar, the live-status seed.
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
