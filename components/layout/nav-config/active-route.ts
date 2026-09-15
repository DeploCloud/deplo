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

export function onSubRoute(
  pathname: string,
  base: string,
  seg: string,
): boolean {
  return pathname === base + seg || pathname.startsWith(base + seg + "/");
}

export const NON_TEAM_SETTINGS_PREFIXES = [
  "/settings/account",
  "/settings/security",
  "/settings/tokens",
  "/settings/users",
  "/settings/servers",
  "/settings/deplo",
  "/settings/migrations",
];

export function isNonTeamSettings(pathname: string): boolean {
  return NON_TEAM_SETTINGS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}
