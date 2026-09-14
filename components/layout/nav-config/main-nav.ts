import {
  LayoutGrid,
  Rocket,
  ScrollText,
  Database,
  LayoutTemplate,
  Activity,
  LineChart,
  Braces,
} from "lucide-react";

import type { NavSection } from "./nav-item";

export const NAV: NavSection[] = [
  {
    items: [
      {
        label: "Overview",
        href: "/",
        icon: LayoutGrid,
        tooltip: "Projects, folders & apps overview",
        exact: true,
      },
      {
        label: "Deployments",
        href: "/deployments",
        icon: Rocket,
        tooltip: "All deployments across apps",
      },
      {
        label: "Logs",
        href: "/logs",
        icon: ScrollText,
        tooltip: "Runtime and build logs",
        requires: "view_logs",
      },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      {
        label: "Storage",
        href: "/storage",
        icon: Database,
        tooltip: "Databases, backup destinations & backups",
      },
      {
        label: "Variables",
        href: "/variables",
        icon: Braces,
        tooltip: "App, shared & global environment variables",
        requires: "manage_env",
      },
      {
        label: "Templates",
        href: "/templates",
        icon: LayoutTemplate,
        tooltip: "One-click deploy templates",
        // No capability: anyone on the team may read the catalogue; `createApp`
        // gates the Deploy button with `create_apps`.
      },
      // Plugins deliberately have NO nav entry (ADR-0013): the feature is
      // deferred and `/plugins/<slug>` stays reserved for a plugin's own routes.
    ],
  },
  {
    title: "Workspace",
    items: [
      // Members lives under Settings → Team, beside the Roles page that defines
      // what a member can do - one decision, one place.
      {
        label: "Activity",
        href: "/activity",
        icon: Activity,
        tooltip: "Audit log of workspace events",
        requires: "view_activity",
      },
      {
        label: "Monitoring",
        href: "/monitoring",
        icon: LineChart,
        tooltip: "Real-time server metrics",
        requires: "view_metrics",
      },
      // Settings is NOT here: it sits in the sidebar's own footer, because it is
      // a way OUT of the workspace rather than a place in it.
    ],
  },
];
