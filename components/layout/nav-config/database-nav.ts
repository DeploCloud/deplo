import {
  Timer,
  LayoutDashboard,
  ScrollText,
  Settings,
  Activity,
  LineChart,
  SquareTerminal,
  Archive,
  Settings2,
  Network,
  SlidersHorizontal,
  Cpu,
} from "lucide-react";

import type { DatabaseType } from "@/lib/types/database";

import { onSubRoute } from "./active-route";
import { backSection, itemIf, type NavSection } from "./nav-item";

// databaseNav - a database's navigation.
export function databaseNav(
  id: string,
  f: {
    pathname: string;
    consoleAcknowledged: boolean;
    cronsEnabled: boolean;
    // The database's own logo and its engine, for the Overview entry's mark. Both
    // absent until the layout has published them (see AppNavFlags.logo).
    logo?: string | null;
    type?: DatabaseType;
  },
): NavSection[] {
  const base = `/storage/databases/${id}`;
  const on = (seg: string) => onSubRoute(f.pathname, base, seg);
  const onConsole = on("/console");
  return [
    backSection("Back to storage", "/storage", "Return to storage", true),
    {
      items: [
        {
          label: "Overview",
          href: base,
          icon: LayoutDashboard,
          ...(f.type
            ? {
                mark: {
                  kind: "database" as const,
                  logo: f.logo ?? null,
                  type: f.type,
                },
              }
            : {}),
          tooltip: "Database overview",
          // Every DB route starts with `base`, so Overview must match exactly.
          exact: true,
        },
        {
          label: "Logs",
          href: `${base}/logs`,
          icon: ScrollText,
          tooltip: "Runtime logs",
        },
        {
          label: "Monitoring",
          href: `${base}/monitoring`,
          icon: LineChart,
          tooltip: "Live resource usage",
        },
        // An ADVANCED surface - a live shell into the container. Hidden until the
        // user confirms the one-time warning, and kept while the page is open.
        ...itemIf(f.consoleAcknowledged || onConsole, {
          label: "Console",
          href: `${base}/console`,
          icon: SquareTerminal,
          tooltip: "Container console",
          requires: "open_database_console",
        }),
        ...itemIf(f.cronsEnabled || on("/cron-jobs"), {
          label: "Cron jobs",
          href: `${base}/cron-jobs`,
          icon: Timer,
          tooltip: "Scheduled commands and their run history",
          requires: "manage_crons",
        }),
        {
          label: "Backups",
          href: `${base}/backups`,
          icon: Archive,
          tooltip: "Backups & restore",
          requires: "manage_backups",
        },
        {
          label: "Activity",
          href: `${base}/activity`,
          icon: Activity,
          tooltip: "Who changed what, and when",
          requires: "view_activity",
        },
        {
          label: "Settings",
          href: `${base}/settings`,
          icon: Settings,
          tooltip: "Database settings",
        },
      ],
    },
  ];
}

// databaseSettingsNav - a database's SETTINGS sub-menu, the DB twin of appSettingsNav.
export function databaseSettingsNav(id: string): NavSection[] {
  const base = `/storage/databases/${id}/settings`;
  return [
    // Back goes UP to the overview as a plain link, not through history, which
    // would exit the section.
    backSection(
      "Back to database",
      `/storage/databases/${id}`,
      "Return to the database overview",
    ),
    {
      title: "Settings",
      iconless: true,
      items: [
        {
          label: "General",
          href: base,
          icon: Settings2,
          tooltip: "Name & logo",
          exact: true,
        },
        {
          label: "Connection",
          href: `${base}/connection`,
          icon: Network,
          tooltip: "Exposure, server & password",
        },
        {
          label: "Resources",
          href: `${base}/resources`,
          icon: Cpu,
          tooltip: "RAM, CPU & other limits",
        },
        {
          label: "Advanced",
          href: `${base}/advanced`,
          icon: SlidersHorizontal,
          tooltip: "Console, cron jobs, image & danger zone",
        },
      ],
    },
  ];
}
