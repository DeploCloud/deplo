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

export function useTeamSlug(): string | null {
  return teamSlugFromPath(useNextPathname());
}

export function useFlatPathname(): string {
  return flatPath(useNextPathname());
}

let localRefreshAt = 0;

/** When this tab last re-read its page itself, so a team change it made does not refresh it twice. */
export function lastLocalRefresh(): number {
  return localRefreshAt;
}

export function useRouter() {
  const router = useNextRouter();
  const slug = useTeamSlug();
  return React.useMemo(
    () => ({
      ...router,
      refresh: () => {
        localRefreshAt = Date.now();
        router.refresh();
      },
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
