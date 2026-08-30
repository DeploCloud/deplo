"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The dashboard's outer frame, split out of `AppShell` so it can know the route.
 * Here, every other route renders the markup it rendered before, attribute for
 * attribute.
 */
const FULL_BLEED = [
  // The general Logs page is BOTH of its states: the chooser is a full-screen
  // step, and this matches on the pathname only, so one entry covers the pane
  // at `/logs?app=…` too.
  /^\/logs\/?$/,
  /^\/apps\/[^/]+\/logs\/?$/,
  /^\/storage\/databases\/[^/]+\/logs\/?$/,
  /^\/apps\/[^/]+\/console\/?$/,
  /^\/storage\/databases\/[^/]+\/console\/?$/,
];

/**
 * Is the current route one of the full-bleed ones? Exported because the shell is
 * not the only thing in the way: an app's own layout adds a `max-w-6xl` measure
 * and a header of name, status and controls, and a database's does the same.
 */
export function useFullBleedRoute(): boolean {
  const pathname = usePathname();
  return FULL_BLEED.some((re) => re.test(pathname));
}

export function ShellFrame({
  sidebar,
  header,
  contentKey,
  children,
}: {
  sidebar: React.ReactNode;
  /** Topbar plus anything that stacks under it (banners, reminders). */
  header: React.ReactNode;
  /** The active team's id. Keys the content so switching teams REMOUNTS the
   *  page instead of re-rendering it in place - see the note in `AppShell`. */
  contentKey: string;
  children: React.ReactNode;
}) {
  const full = useFullBleedRoute();

  return (
    <div
      className={cn(
        "flex w-full",
        full ? "h-dvh overflow-hidden" : "min-h-screen",
      )}
    >
      {sidebar}
      <div className="flex min-w-0 flex-1 flex-col">
        {header}
        <main
          className={cn(
            full
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "flex-1 px-4 py-6 sm:px-6 lg:px-8",
          )}
        >
          <div
            key={contentKey}
            className={cn(
              full
                ? "flex min-h-0 w-full flex-1 flex-col"
                : "mx-auto w-full max-w-345",
            )}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
