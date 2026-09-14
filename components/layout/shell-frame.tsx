"use client";

import { useFlatPathname } from "@/lib/nav";
import { cn } from "@/lib/utils";

const FULL_BLEED = [
  /^\/logs\/?$/,
  /^\/apps\/[^/]+\/logs\/?$/,
  /^\/storage\/databases\/[^/]+\/logs\/?$/,
  /^\/apps\/[^/]+\/console\/?$/,
  /^\/storage\/databases\/[^/]+\/console\/?$/,
];

const DOTTED = [/^\/$/, /^\/apps\/?$/, /^\/storage\/?$/];

export function isDottedRoute(pathname: string): boolean {
  return DOTTED.some((re) => re.test(pathname));
}

// useFullBleedRoute - is the current route one of the full-bleed ones?
export function useFullBleedRoute(): boolean {
  const pathname = useFlatPathname();
  return FULL_BLEED.some((re) => re.test(pathname));
}

export function ShellFrame({
  sidebar,
  header,
  contentKey,
  children,
}: {
  sidebar: React.ReactNode;
  header: React.ReactNode;
  contentKey: string;
  children: React.ReactNode;
}) {
  const pathname = useFlatPathname();
  const full = useFullBleedRoute();
  const dotted = !full && isDottedRoute(pathname);

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
          data-selection-region=""
          className={cn(
            full
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "flex-1 px-4 py-6 sm:px-6 lg:px-8",
            dotted && "deplo-grid-bg",
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
