const RESOURCE_ROUTES: ReadonlyArray<{ base: string; fallback: string }> = [
  { base: "/storage/databases", fallback: "/storage" },
  { base: "/apps", fallback: "/" },
  { base: "/projects", fallback: "/" },
];

export function teamSwitchDestination(pathname: string): string {
  const path = pathname.split("?")[0].split("#")[0] || "/";
  const clean =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

  for (const route of RESOURCE_ROUTES) {
    if (clean === route.base || clean.startsWith(route.base + "/")) {
      return route.fallback;
    }
  }
  return clean;
}
