"use client";

import * as React from "react";
import {
  usePathname as useNextPathname,
  useRouter as useNextRouter,
} from "next/navigation";

import { flatPath, teamSlugFromPath, withTeam } from "./team-path";

export {
  useParams,
  usePathname,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
} from "next/navigation";

/** The team the open page belongs to, or null outside the dashboard. */
export function useTeamSlug(): string | null {
  return teamSlugFromPath(useNextPathname());
}

/**
 * The open path WITHOUT its team segment, which is how every path in this
 * codebase is written - so it is what a nav model or a tab bar compares against.
 */
export function useFlatPathname(): string {
  return flatPath(useNextPathname());
}

/**
 * `next/navigation`'s router with the team the page is in put back on the path.
 * Import it from here, never from `next/navigation`, so a push stays in the team
 * the viewer is looking at (eslint enforces it).
 */
export function useRouter() {
  const router = useNextRouter();
  const slug = useTeamSlug();
  return React.useMemo(
    () => ({
      ...router,
      push: (href: string, options?: Parameters<typeof router.push>[1]) =>
        router.push(withTeam(href, slug), options),
      replace: (href: string, options?: Parameters<typeof router.replace>[1]) =>
        router.replace(withTeam(href, slug), options),
      prefetch: (
        href: string,
        options?: Parameters<typeof router.prefetch>[1],
      ) => router.prefetch(withTeam(href, slug), options),
    }),
    [router, slug],
  );
}
