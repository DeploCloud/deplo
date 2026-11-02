"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "@/lib/nav";

// The Overview's drill-ins are places of their own; a filter or a search is not.
const PLACE_PARAMS = ["project", "env", "folder"] as const;

export function placeKey(pathname: string, params: URLSearchParams): string {
  return [pathname, ...PLACE_PARAMS.map((k) => params.get(k) ?? "")].join("|");
}

// Every navigation opens at the top, Back included: the browser's own restore runs before the
// page has streamed in, and lands mid-page.
export function ScrollToTop(): null {
  const place = placeKey(usePathname(), useSearchParams());
  React.useEffect(() => {
    window.history.scrollRestoration = "manual";
  }, []);
  React.useEffect(() => {
    window.scrollTo(0, 0);
  }, [place]);
  return null;
}

/** Tapping the nav entry for the page already on screen reloads it and goes back to the top. */
export function useRetapRefresh() {
  const router = useRouter();
  return React.useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return false;
      const here = new URL(window.location.href);
      const to = new URL(e.currentTarget.href, here);
      if (to.pathname !== here.pathname || to.search !== here.search)
        return false;
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
      router.refresh();
      return true;
    },
    [router],
  );
}
