import {
  LayoutGrid,
  Rocket,
  ScrollText,
  Database,
  Globe,
  LayoutTemplate,
  Server,
  Settings,
  Activity,
  LineChart,
  Braces,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  tooltip: string;
  /** exact match for active state (default: startsWith) */
  exact?: boolean;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    items: [
      {
        label: "Overview",
        href: "/",
        icon: LayoutGrid,
        tooltip: "Projects & usage overview",
        exact: true,
      },
      {
        label: "Deployments",
        href: "/deployments",
        icon: Rocket,
        tooltip: "All deployments across projects",
      },
      {
        label: "Logs",
        href: "/logs",
        icon: ScrollText,
        tooltip: "Runtime and build logs",
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
        tooltip: "Databases, S3 destinations & backups",
      },
      {
        label: "Domains",
        href: "/domains",
        icon: Globe,
        tooltip: "Custom domains & TLS certificates",
      },
      {
        label: "Variables",
        href: "/variables",
        icon: Braces,
        tooltip: "Project & shared environment variables",
      },
      {
        label: "Servers",
        href: "/servers",
        icon: Server,
        tooltip: "Connected servers & Docker hosts",
      },
      {
        label: "Templates",
        href: "/templates",
        icon: LayoutTemplate,
        tooltip: "One-click deploy templates",
      },
    ],
  },
  {
    title: "Workspace",
    items: [
      {
        label: "Activity",
        href: "/activity",
        icon: Activity,
        tooltip: "Audit log of workspace events",
      },
      {
        label: "Monitoring",
        href: "/monitoring",
        icon: LineChart,
        tooltip: "Real-time server metrics",
      },
      {
        label: "Settings",
        href: "/settings",
        icon: Settings,
        tooltip: "Team, members, tokens & security",
      },
    ],
  },
];
