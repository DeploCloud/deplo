// sidebarMenuFor - which of the four navigations the sidebar shows, and the ids it
// needs to build it. Also read by the sidebar's footer, which hides itself in every
// drill-in, where the way back is the nav's own first row.
export function sidebarMenuFor(pathname: string): {
  appSlug: string | null;
  dbId: string | null;
  inAppSettings: boolean;
  inDbSettings: boolean;
  inSettings: boolean;
  menu: "main" | "service" | "service-settings" | "settings";
} {
  const appSlug = pathname.match(/^\/apps\/([^/]+)/)?.[1] ?? null;
  const dbId = pathname.match(/^\/storage\/databases\/([^/]+)/)?.[1] ?? null;
  const inAppSettings =
    appSlug != null && /^\/apps\/[^/]+\/settings(?:\/|$)/.test(pathname);
  const inDbSettings =
    dbId != null &&
    /^\/storage\/databases\/[^/]+\/settings(?:\/|$)/.test(pathname);
  const inSettings = pathname.startsWith("/settings");
  return {
    appSlug,
    dbId,
    inAppSettings,
    inDbSettings,
    inSettings,
    menu:
      appSlug || dbId
        ? inAppSettings || inDbSettings
          ? "service-settings"
          : "service"
        : inSettings
          ? "settings"
          : "main",
  };
}

// onSubRoute - true while `base + seg` is the page currently open.
export function onSubRoute(
  pathname: string,
  base: string,
  seg: string,
): boolean {
  return pathname === base + seg || pathname.startsWith(base + seg + "/");
}

// NON_TEAM_SETTINGS_PREFIXES - the settings routes that are NOT team-scoped, so the
// topbar hides the team switcher on them.
export const NON_TEAM_SETTINGS_PREFIXES = [
  "/settings/account",
  // Two-factor enrolment belongs to the ACCOUNT, not to a team, and it must stay
  // reachable when a team's 2FA policy has locked the member out of that team.
  "/settings/security",
  "/settings/tokens",
  "/settings/users",
  "/settings/servers",
  "/settings/deplo",
  "/settings/migrations",
];

// isNonTeamSettings - true when the path is a personal/system settings route.
export function isNonTeamSettings(pathname: string): boolean {
  return NON_TEAM_SETTINGS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}
