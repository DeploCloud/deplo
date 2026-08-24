"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The dashboard's outer frame, split out of `AppShell` so it can know the route.
 *
 * Almost every page is a document that scrolls: the shell is `min-h-screen`, the
 * topbar is sticky, and `main` carries the page padding and the `max-w-345`
 * measure. The log consoles are the exception — they want the whole area to the
 * right of the sidebar, floor to ceiling, and a pane can only fill the viewport
 * if some ancestor has a definite height to fill.
 *
 * So the frame flips, and only on those routes: the shell becomes `h-dvh`, the
 * padding and the measure come off, and `main` becomes the box the page fills.
 * Doing it per route rather than everywhere is deliberate. Making `main` the
 * scroll container for the whole dashboard would move scroll position
 * restoration, in-page anchors and every sticky element inside every page off
 * the document and onto a div, which is a lot of surface to re-verify for a
 * change only one page needs. Here, every other route renders the markup it
 * rendered before, attribute for attribute.
 *
 * The alternative — negative margins and `h-[calc(100dvh-3.5rem)]` on the page
 * itself — was rejected because `UpdateBanner` and `TwoFactorReminder` sit
 * between the topbar and `main` and have a height nobody can put in that
 * subtraction: with either of them up, the pane hangs past the bottom of the
 * viewport. Flexbox already knows their height. Let it do the arithmetic.
 */
const FULL_BLEED = [
  /^\/apps\/[^/]+\/logs\/?$/,
  /^\/storage\/databases\/[^/]+\/logs\/?$/,
];

/**
 * Is the current route one of the full-bleed ones?
 *
 * Exported because the shell is not the only thing in the way: an app's own
 * layout adds a `max-w-6xl` measure and a header of name, status and controls,
 * and a database's does the same. Both consult this so the three of them agree
 * on one list — a page that escaped the shell only to sit inside a 72rem column
 * with a Redeploy button above it is not full-bleed, it is just missing a title.
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
   *  page instead of re-rendering it in place — see the note in `AppShell`. */
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
