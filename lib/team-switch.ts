// Matched against the whole path, so /storage/databases must precede anything that shadows it.
const RESOURCE_ROUTES: ReadonlyArray<{ base: string; fallback: string }> = [
  { base: "/storage/databases", fallback: "/storage" },
  { base: "/apps", fallback: "/" },
  // /projects/* are redirect stubs: a fallback of "/projects" bounces to `/?project=<slug of the OTHER team>`.
  { base: "/projects", fallback: "/" },
];

// teamSwitchDestination is the path to navigate to after switching the active team.
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
