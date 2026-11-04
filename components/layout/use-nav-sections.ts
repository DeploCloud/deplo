"use client";

import { useFlatPathname } from "@/lib/nav";
import { useAppNav, type AppNavState } from "@/components/apps/app-nav-store";
import { useDbNav } from "@/components/storage/db-nav-store";
import { useConsoleAck } from "@/components/apps/console-ack";
import { sidebarMenuFor } from "./nav-config/active-route";
import { appNav, appSettingsNav } from "./nav-config/app-nav";
import { databaseNav, databaseSettingsNav } from "./nav-config/database-nav";
import { NAV } from "./nav-config/main-nav";
import { canSee, type NavSection } from "./nav-config/nav-item";
import { SETTINGS_NAV } from "./nav-config/settings-nav";

// The menu for where you are (main, an App, a database, settings), filtered to what you may open.
// `app` is what the App's own page already knows, for the render before the store has it.
export function useNavSections(
  capabilities: string[],
  isAdmin: boolean,
  app?: AppNavState,
) {
  const pathname = useFlatPathname();
  const caps = new Set(capabilities);
  const stored = useAppNav();
  const service = app && stored?.slug !== app.slug ? app : stored;
  const dbNav = useDbNav();
  const consoleAcknowledged = useConsoleAck() === true;

  const { appSlug, dbId, inAppSettings, inDbSettings, inSettings, menu } =
    sidebarMenuFor(pathname);

  const appCaps =
    appSlug && service?.slug === appSlug ? new Set(service.capabilities) : caps;

  let sections: NavSection[];
  if (dbId && inDbSettings) {
    sections = databaseSettingsNav(dbId);
  } else if (dbId) {
    const matches = dbNav?.id === dbId;
    sections = databaseNav(dbId, {
      pathname,
      consoleAcknowledged,
      cronsEnabled: matches ? dbNav!.cronsEnabled : false,
      logo: matches ? dbNav!.logo : undefined,
      type: matches ? dbNav!.type : undefined,
    });
  } else if (appSlug && inAppSettings) {
    sections = appSettingsNav(
      appSlug,
      service?.slug === appSlug ? service.isGithubApp : true,
    );
  } else if (appSlug) {
    const matches = service?.slug === appSlug;
    sections = appNav(appSlug, {
      pathname,
      canManageEnv: appCaps.has("manage_env"),
      canBackup: appCaps.has("manage_backups"),
      running: matches ? service!.running : false,
      isGithubApp: matches ? service!.isGithubApp : false,
      previewsEnabled: matches ? service!.previewsEnabled : false,
      cronsEnabled: matches ? service!.cronsEnabled : false,
      logo: matches ? service!.logo : undefined,
      consoleEnabled: matches ? service!.consoleEnabled : false,
    });
  } else if (inSettings) {
    sections = SETTINGS_NAV;
  } else {
    sections = NAV;
  }

  const rendered = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        canSee(item, appSlug ? appCaps : caps, isAdmin),
      ),
    }))
    .filter((section) => section.items.length > 0);

  return { pathname, menu, appSlug, sections: rendered };
}
