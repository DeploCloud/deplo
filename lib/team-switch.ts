/**
 * Where the dashboard should land when the ACTIVE TEAM changes.
 *
 * Switching teams used to always drop the viewer on the Overview, which throws
 * away where they were even though most of the dashboard is the same page in
 * every team: Storage, Variables, Templates, Deployments, Logs,
 * Monitoring, Members, Activity and Settings are *sections*, not rows — the
 * team only decides what they list. Leaving those is the exception, not the
 * rule.
 *
 * So the rule is: stay put, unless the URL names a specific team-owned resource
 * (an App, a Database, a Project) — that row belongs to the team just left and
 * has no counterpart in the new one, so fall back to the nearest section page,
 * the same destination that section's "back" nav entry uses.
 */

/**
 * Route bases that address ONE team-owned resource, with the section page to
 * fall back to. Matched against the whole path, so the database entry (nested
 * under /storage) has to come before anything that could shadow it.
 */
const RESOURCE_ROUTES: ReadonlyArray<{ base: string; fallback: string }> = [
  // A database — the Storage list exists in every team, and it is where
  // databaseNav's "Back to storage" goes.
  { base: "/storage/databases", fallback: "/storage" },
  // An App. There is no /apps list page (the Overview grid IS the list), which
  // is also where appNav's "Back to apps" goes.
  { base: "/apps", fallback: "/" },
  // A Project is browsed on the Overview drill-in; /projects/* are redirect
  // stubs that would bounce to `/?project=<slug of the OTHER team>`.
  { base: "/projects", fallback: "/" },
];

/**
 * The path to navigate to after switching the active team, given the path the
 * viewer is on. Always returns a path with NO query string: search params carry
 * filters and selections (`?project=`, `?folder=`, `?template=`, `?repo=`) that
 * name rows of the team being left.
 */
export function teamSwitchDestination(pathname: string): string {
  const path = pathname.split("?")[0].split("#")[0] || "/";
  // Tolerate a trailing slash so "/variables/" doesn't become its own case.
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

  for (const route of RESOURCE_ROUTES) {
    if (clean === route.base || clean.startsWith(route.base + "/")) {
      return route.fallback;
    }
  }
  return clean;
}
