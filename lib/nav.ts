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

// useFlatPathname is the open path WITHOUT its team segment, how every path here is written.
export function useFlatPathname(): string {
  return flatPath(useNextPathname());
}

// useRouter re-adds the team to every push: import it from here, never from `next/navigation` (eslint enforces it).
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
